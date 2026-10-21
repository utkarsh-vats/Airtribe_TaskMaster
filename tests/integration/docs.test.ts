import SwaggerParser from '@apidevtools/swagger-parser';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';

/*
 * Drift guard setup. Express 5's router doesn't keep mount paths on its layers (only compiled
 * matchers), so the registered routes can't be rebuilt from the stack alone. Instead, wrap the
 * shared Router.prototype.use *before* the app is imported, to record which router is mounted
 * under which path. Routes themselves keep their path (`layer.route.path`), so walking
 * root → mounted routers → routes gives every METHOD + full path. This touches only the test;
 * the app registers routes exactly as in production.
 */

type RouterLike = ((...args: never[]) => unknown) & { stack: unknown[] };

function isRouterLike(value: unknown): value is RouterLike {
    return typeof value === 'function' && Array.isArray(Reflect.get(value, 'stack'));
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

const mounts = new WeakMap<object, { path: string; router: RouterLike }[]>();

type UseFn = (this: object, ...args: unknown[]) => unknown;
type RouterPrototype = { use: UseFn };

// A router function's prototype is its own Router instance; that instance's prototype is the
// shared Router.prototype (in router 2.x a function object, so check for both kinds).
function isRouterPrototype(value: unknown): value is RouterPrototype {
    return (
        (typeof value === 'object' || typeof value === 'function') &&
        value !== null &&
        typeof Reflect.get(value, 'use') === 'function'
    );
}

const routerPrototype: unknown = Object.getPrototypeOf(Object.getPrototypeOf(express.Router()));
if (!isRouterPrototype(routerPrototype)) {
    throw new Error('Unexpected Express router shape; the drift guard needs updating');
}
const originalUse = routerPrototype.use;
routerPrototype.use = function recordingUse(this: object, ...args: unknown[]): unknown {
    const mountPath = typeof args[0] === 'string' ? args[0] : '/';
    for (const handler of args.flat(Infinity)) {
        if (isRouterLike(handler)) {
            const list = mounts.get(this) ?? [];
            list.push({ path: mountPath, router: handler });
            mounts.set(this, list);
        }
    }
    return Reflect.apply(originalUse, this, args);
};

/** `/a/` + `/:id/` → `/a/{id}`, as OpenAPI writes paths. */
function normalise(path: string): string {
    const joined = path.replace(/\/+/g, '/');
    const trimmed = joined.length > 1 ? joined.replace(/\/$/, '') : joined;
    return trimmed.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function collectRoutes(router: RouterLike, prefix: string, out: Set<string>): void {
    for (const layer of router.stack) {
        const route = isObject(layer) ? layer.route : undefined;
        if (isObject(route) && typeof route.path === 'string' && isObject(route.methods)) {
            for (const [method, enabled] of Object.entries(route.methods)) {
                if (enabled === true && method !== '_all') {
                    out.add(`${method.toUpperCase()} ${normalise(`${prefix}/${route.path}`)}`);
                }
            }
        }
    }
    for (const mount of mounts.get(router) ?? []) {
        collectRoutes(mount.router, `${prefix}/${mount.path}`, out);
    }
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type ApiDocument = Exclude<Parameters<typeof SwaggerParser.validate>[0], string>;

/** Shape check only, to hand the JSON to the validator, which does the real validation. */
function isApiDocument(value: unknown): value is ApiDocument {
    return isObject(value) && typeof value.openapi === 'string' && isObject(value.info);
}

function specOperations(doc: unknown): Set<string> {
    const out = new Set<string>();
    const paths = isObject(doc) && isObject(doc.paths) ? doc.paths : {};
    for (const [path, item] of Object.entries(paths)) {
        if (!isObject(item)) continue;
        for (const method of HTTP_METHODS) {
            if (method in item) out.add(`${method.toUpperCase()} ${path}`);
        }
    }
    return out;
}

/** Routes that serve the docs themselves, not part of the API. */
const DOC_ROUTES = new Set(['GET /openapi.json']);

let app: Express;

beforeAll(async () => {
    const { createApp } = await import('../../src/app.js');
    app = createApp();
});

afterAll(async () => {
    routerPrototype.use = originalUse;
    await prisma.$disconnect();
});

async function fetchSpec(): Promise<Record<string, unknown>> {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(isObject(res.body)).toBe(true);
    return res.body as Record<string, unknown>;
}

describe('GET /openapi.json', () => {
    it('serves a valid OpenAPI 3.1 document', async () => {
        const doc = await fetchSpec();

        expect(String(doc.openapi)).toMatch(/^3\.1/);
        // validate() dereferences in place, so give it a copy.
        const copy: unknown = structuredClone(doc);
        if (!isApiDocument(copy)) throw new Error('Not an OpenAPI document');
        await expect(SwaggerParser.validate(copy)).resolves.toBeDefined();
    });

    it('the validator really rejects a broken 3.1 document', async () => {
        // info.version is required.
        const broken: unknown = { openapi: '3.1.0', info: { title: 'x' }, paths: {} };
        if (!isApiDocument(broken)) throw new Error('Not an OpenAPI document');
        await expect(SwaggerParser.validate(broken)).rejects.toThrow();
    });

    it('documents all 44 operations, tagged, with bearer auth except the public ones', async () => {
        const doc = await fetchSpec();
        const paths = isObject(doc.paths) ? doc.paths : {};
        const publicOps: string[] = [];
        const tags = new Set<string>();
        let count = 0;

        for (const [path, item] of Object.entries(paths)) {
            if (!isObject(item)) continue;
            for (const method of HTTP_METHODS) {
                const op = item[method];
                if (!isObject(op)) continue;
                count += 1;
                const opTags = Array.isArray(op.tags) ? op.tags : [];
                expect(opTags).toHaveLength(1);
                tags.add(String(opTags[0]));
                if (Array.isArray(op.security) && op.security.length === 0) {
                    publicOps.push(`${method.toUpperCase()} ${path}`);
                }
            }
        }

        expect(count).toBe(44);
        expect([...tags].sort()).toEqual(
            [
                'AI',
                'Attachments',
                'Auth',
                'Comments',
                'Health',
                'Invitations',
                'Members',
                'Notifications',
                'Projects',
                'Tasks',
                'Users',
            ].sort(),
        );
        expect(publicOps.sort()).toEqual(
            [
                'GET /health',
                'POST /api/v1/auth/login',
                'POST /api/v1/auth/logout',
                'POST /api/v1/auth/refresh',
                'POST /api/v1/auth/register',
            ].sort(),
        );
        expect(doc.security).toEqual([{ bearerAuth: [] }]);
    });

    it('takes request bodies and query params from the route schemas', async () => {
        const doc = await fetchSpec();
        const paths = isObject(doc.paths) ? doc.paths : {};
        const tasks = paths['/api/v1/projects/{projectId}/tasks'];
        if (!isObject(tasks) || !isObject(tasks.post) || !isObject(tasks.get)) {
            throw new Error('tasks path missing');
        }

        expect(tasks.post.requestBody).toMatchObject({
            content: {
                'application/json': {
                    schema: { required: ['title'], additionalProperties: false },
                },
            },
        });
        const params = Array.isArray(tasks.get.parameters) ? tasks.get.parameters : [];
        const byName = new Map(params.filter(isObject).map((p) => [String(p.name), p] as const));
        expect(byName.get('status')).toMatchObject({
            style: 'form',
            explode: false,
            schema: { type: 'array', items: { enum: ['OPEN', 'IN_PROGRESS', 'COMPLETED'] } },
        });
        expect(byName.get('sort')).toMatchObject({
            schema: {
                default: 'createdAt',
                enum: ['dueDate', 'createdAt', 'updatedAt', 'priority', 'title'],
            },
        });
        expect(byName.get('limit')).toMatchObject({ schema: { default: 20, maximum: 100 } });
        expect([...byName.keys()].sort()).toEqual(
            [
                'assignee',
                'createdBy',
                'dueAfter',
                'dueBefore',
                'limit',
                'order',
                'overdue',
                'page',
                'priority',
                'q',
                'sort',
                'status',
            ].sort(),
        );
    });
});

describe('route drift guard', () => {
    it('every registered route is documented, and every documented operation exists', async () => {
        const routes = new Set<string>();
        const root: unknown = Reflect.get(app, 'router');
        if (!isRouterLike(root)) throw new Error('app.router is not a router');
        collectRoutes(root, '', routes);
        for (const route of DOC_ROUTES) routes.delete(route);
        const documented = specOperations(await fetchSpec());

        // Sanity: the walk reached the deepest mounts.
        expect(routes).toContain(
            'GET /api/v1/projects/{projectId}/attachments/{attachmentId}/download',
        );
        expect(routes.size).toBe(44);

        const undocumented = [...routes].filter((r) => !documented.has(r)).sort();
        const unregistered = [...documented].filter((r) => !routes.has(r)).sort();
        expect({ undocumented, unregistered }).toEqual({ undocumented: [], unregistered: [] });
    });
});

describe('GET /docs', () => {
    it('serves Swagger UI as HTML', async () => {
        const res = await request(app).get('/docs').redirects(1);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.text).toContain('id="swagger-ui"');
        expect(res.text).toContain('<title>TaskMaster API docs</title>');
    });

    it('works under the default CSP: only same-origin scripts, no inline ones', async () => {
        const res = await request(app).get('/docs').redirects(1);

        expect(res.headers['content-security-policy']).toContain("script-src 'self'");
        const scripts = res.text.match(/<script\b[^>]*>/g) ?? [];
        expect(scripts.length).toBeGreaterThan(0);
        for (const tag of scripts) {
            expect(tag).toMatch(/\bsrc="\.\/[^"]+"/);
        }
    });

    it('serves the init script with the embedded spec', async () => {
        const res = await request(app).get('/docs/swagger-ui-init.js');

        expect(res.status).toBe(200);
        expect(res.text).toContain('TaskMaster API');
    });
});
