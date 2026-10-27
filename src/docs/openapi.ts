import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    InvitationStatus,
    NotificationType,
    ProjectRole,
    TaskPriority,
    TaskStatus,
} from '@prisma/client';
import { z } from 'zod';
import { paginationQuerySchema } from '../lib/pagination';
import { taskDescriptionBodySchema } from '../modules/ai/ai.schemas';
import {
    listAttachmentsQuerySchema,
    uploadAttachmentBodySchema,
} from '../modules/attachments/attachments.schemas';
import {
    loginBodySchema,
    refreshTokenBodySchema,
    registerBodySchema,
} from '../modules/auth/auth.schemas';
import {
    createCommentBodySchema,
    listCommentsQuerySchema,
    listRepliesQuerySchema,
    updateCommentBodySchema,
} from '../modules/comments/comments.schemas';
import {
    createInvitationBodySchema,
    listInvitationsQuerySchema,
} from '../modules/members/invitations.schemas';
import { updateMemberRoleBodySchema } from '../modules/members/members.schemas';
import { listNotificationsQuerySchema } from '../modules/notifications/notifications.schemas';
import {
    createProjectBodySchema,
    updateProjectBodySchema,
} from '../modules/projects/projects.schemas';
import { myTasksQuerySchema, taskListQuerySchema } from '../modules/tasks/tasks.query';
import { createTaskBodySchema, updateTaskBodySchema } from '../modules/tasks/tasks.schemas';
import { changePasswordBodySchema, updateMeBodySchema } from '../modules/users/users.schemas';

/**
 * OpenAPI 3.1 document for the whole API, served at /openapi.json and /docs. Request bodies
 * and query params are converted from the same Zod schemas the routes validate with, so they
 * can't drift; paths are listed explicitly and a test checks them against the registered routes.
 */

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------
// Zod → JSON Schema
// ---------------------------------------------------------------------------------------------

/** Drops noise from z.toJSONSchema output: `$schema`, regexes that duplicate a `format`, and
 * the MAX_SAFE_INTEGER bound Zod puts on `.int()`. */
function clean(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(clean);
    if (!isObject(node)) return node;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
        if (key === '$schema') continue;
        if (key === 'pattern' && typeof node.format === 'string') continue;
        if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
        if (key === 'minimum' && value === Number.MIN_SAFE_INTEGER) continue;
        out[key] = clean(value);
    }
    return out;
}

/**
 * JSON Schema (draft 2020-12, which OpenAPI 3.1 uses) for what a client sends: the input side
 * of transforms and coercions. Refinements can't be expressed and are documented separately.
 */
function jsonSchema(schema: z.ZodType): JsonObject {
    const converted = clean(
        z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' }),
    );
    if (!isObject(converted)) throw new Error('Expected an object JSON Schema');
    return converted;
}

/** `jsonSchema` with some properties' schemas extended (e.g. formats Zod can't see). */
function withProperties(schema: JsonObject, extra: Record<string, JsonObject>): JsonObject {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const merged: JsonObject = { ...properties };
    for (const [name, patch] of Object.entries(extra)) {
        const current = merged[name];
        merged[name] = { ...(isObject(current) ? current : {}), ...patch };
    }
    return { ...schema, properties: merged };
}

/** The email schema trims and lowercases before validating, so the input side is "string". */
const EMAIL = { format: 'email', maxLength: 254 };

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });
const uuid: JsonObject = { type: 'string', format: 'uuid' };
const dateTime: JsonObject = { type: 'string', format: 'date-time' };
const str: JsonObject = { type: 'string' };
const int: JsonObject = { type: 'integer' };
const nullable = (schema: JsonObject): JsonObject => ({ anyOf: [schema, { type: 'null' }] });
const enumOf = (values: Record<string, string>): JsonObject => ({
    type: 'string',
    enum: Object.values(values),
});

/** Closed object: every listed property is required unless named in `optional`. */
function object(properties: JsonObject, optional: string[] = []): JsonObject {
    return {
        type: 'object',
        required: Object.keys(properties).filter((key) => !optional.includes(key)),
        properties,
        additionalProperties: false,
    };
}

const dataEnvelope = (schema: JsonObject): JsonObject => object({ data: schema });
const pageEnvelope = (item: JsonObject, meta = 'PageMeta'): JsonObject =>
    object({ data: { type: 'array', items: item }, meta: ref(meta) });

const json = (schema: JsonObject): JsonObject => ({ 'application/json': { schema } });

const okResponse = (description: string, schema: JsonObject): JsonObject => ({
    description,
    content: json(dataEnvelope(schema)),
});
const pageResponse = (description: string, item: JsonObject, meta?: string): JsonObject => ({
    description,
    content: json(pageEnvelope(item, meta)),
});
const noContent = (description = 'Done; no body'): JsonObject => ({ description });

const jsonBody = (schema: JsonObject): JsonObject => ({ required: true, content: json(schema) });

/** Error responses, shared as components; each route lists only those it can return. */
const ERRORS = {
    400: [
        'BadRequest',
        'Malformed JSON or multipart body (`BAD_REQUEST`), or a wrong current password on change-password (`INVALID_CURRENT_PASSWORD`).',
    ],
    401: [
        'Unauthorized',
        'Missing or invalid bearer token (`UNAUTHORIZED`), expired access token (`TOKEN_EXPIRED`), bad login (`INVALID_CREDENTIALS`) or unusable refresh token (`INVALID_REFRESH_TOKEN`).',
    ],
    403: [
        'Forbidden',
        "Signed in and a project member, but the role or row ownership doesn't allow this (`FORBIDDEN`).",
    ],
    404: [
        'NotFound',
        "The resource doesn't exist, or you aren't a member of its project (`NOT_FOUND`).",
    ],
    409: [
        'Conflict',
        'Conflicts with the current state, e.g. email taken, already a member, invitation no longer pending (`CONFLICT`).',
    ],
    410: ['Gone', 'The invitation has expired (`INVITATION_EXPIRED`).'],
    413: [
        'PayloadTooLarge',
        'Upload over `MAX_UPLOAD_MB`, or JSON body over 1 MB (`PAYLOAD_TOO_LARGE`).',
    ],
    415: ['UnsupportedMediaType', 'Upload type not in the allowlist (`UNSUPPORTED_MEDIA_TYPE`).'],
    422: [
        'ValidationError',
        'Body, path or query failed validation (`VALIDATION_ERROR`); `details` lists each problem.',
    ],
    429: ['RateLimited', 'Too many requests (`RATE_LIMITED`).'],
    502: [
        'AiUpstreamError',
        'The AI provider failed or took longer than 10 s (`AI_UPSTREAM_ERROR`).',
    ],
    503: ['AiDisabled', 'No AI provider is configured (`AI_DISABLED`).'],
} as const;

type ErrorStatus = keyof typeof ERRORS;

function errors(...statuses: ErrorStatus[]): JsonObject {
    return Object.fromEntries(
        statuses.map((status) => [
            String(status),
            { $ref: `#/components/responses/${ERRORS[status][0]}` },
        ]),
    );
}

const pathParam = (name: string, description: string): JsonObject => ({
    name,
    in: 'path',
    required: true,
    description,
    schema: uuid,
});

const PROJECT_ID = pathParam('projectId', 'Project id');

interface QueryOverride {
    schema?: JsonObject;
    description?: string;
    /** Comma-separated lists: OpenAPI's form style without explode. */
    commaSeparated?: boolean;
}

/** One OpenAPI parameter per property of a Zod query schema. */
function queryParams(
    schema: z.ZodType,
    overrides: Record<string, QueryOverride> = {},
): JsonObject[] {
    const converted = jsonSchema(schema);
    const properties = isObject(converted.properties) ? converted.properties : {};
    const required = Array.isArray(converted.required) ? converted.required : [];
    return Object.entries(properties).map(([name, propertySchema]) => {
        const override = overrides[name] ?? {};
        return {
            name,
            in: 'query',
            required: required.includes(name),
            ...(override.description ? { description: override.description } : {}),
            schema: override.schema ?? propertySchema,
            ...(override.commaSeparated ? { style: 'form', explode: false } : {}),
        };
    });
}

const commaList = (values: Record<string, string>, description: string): QueryOverride => ({
    commaSeparated: true,
    description,
    schema: { type: 'array', minItems: 1, items: enumOf(values) },
});

const PAGINATION_DOCS: Record<string, QueryOverride> = {
    page: { description: 'Page number, from 1.' },
    limit: { description: 'Items per page, 1–100.' },
};

const TASK_LIST_DOCS: Record<string, QueryOverride> = {
    ...PAGINATION_DOCS,
    status: commaList(TaskStatus, 'Comma-separated statuses, e.g. `OPEN,IN_PROGRESS`.'),
    priority: commaList(TaskPriority, 'Comma-separated priorities, e.g. `HIGH,URGENT`.'),
    assignee: { description: '`me`, `unassigned`, or a user id.' },
    createdBy: { description: '`me` or a user id.' },
    dueBefore: { description: 'Due strictly before this instant (ISO 8601 with offset).' },
    dueAfter: { description: 'Due strictly after this instant (ISO 8601 with offset).' },
    overdue: {
        description:
            '`true`: due date in the past and not completed. `false`: everything else (undated, not yet due, or completed).',
    },
    q: { description: 'Case-insensitive match in title or description.' },
    sort: {
        description: 'Sort field. Tasks without a due date always sort last; `id` breaks ties.',
    },
    order: {
        description:
            'Default depends on `sort`: `dueDate` asc, `createdAt` desc, `updatedAt` desc, `priority` desc (URGENT first), `title` asc.',
    },
};

const TASK_ID_FILTER: Record<string, QueryOverride> = {
    ...PAGINATION_DOCS,
    taskId: {
        description:
            "A task id for that task only (404 if the task isn't in this project), or `none` for project-level items only. Omit for all.",
    },
};

/** Both comment lists sort by `createdAt` (then `id`), oldest first unless `order=desc`. */
const COMMENT_ORDER: QueryOverride = {
    description: '`asc` (default) for oldest first, `desc` for newest first.',
};

const COMMENT_LIST_DOCS: Record<string, QueryOverride> = {
    ...TASK_ID_FILTER,
    parentId: {
        description:
            "`none` for top-level comments only, or a comment id for that comment's replies. Omit for all.",
    },
    order: COMMENT_ORDER,
};

const COMMENT_REPLIES_DOCS: Record<string, QueryOverride> = {
    ...PAGINATION_DOCS,
    order: COMMENT_ORDER,
};

interface OperationSpec {
    operationId: string;
    tag: string;
    summary: string;
    description?: string;
    /** No bearer token needed. */
    isPublic?: boolean;
    parameters?: JsonObject[];
    requestBody?: JsonObject;
    responses: JsonObject;
}

function operation({
    operationId,
    tag,
    summary,
    description,
    isPublic,
    parameters,
    requestBody,
    responses,
}: OperationSpec): JsonObject {
    return {
        operationId,
        tags: [tag],
        summary,
        ...(description ? { description } : {}),
        ...(isPublic ? { security: [] } : {}),
        ...(parameters?.length ? { parameters } : {}),
        ...(requestBody ? { requestBody } : {}),
        responses,
    };
}

// ---------------------------------------------------------------------------------------------
// Component schemas (response shapes)
// ---------------------------------------------------------------------------------------------

const idName = object({ id: uuid, name: str });
const taskFields: JsonObject = {
    id: uuid,
    projectId: uuid,
    title: str,
    description: nullable(str),
    status: ref('TaskStatus'),
    priority: ref('TaskPriority'),
    dueDate: nullable(dateTime),
    completedAt: { ...nullable(dateTime), description: 'Set while status is COMPLETED.' },
    createdAt: dateTime,
    updatedAt: dateTime,
};
const tokenFields: JsonObject = {
    accessToken: { type: 'string', description: 'JWT; send as `Authorization: Bearer <token>`.' },
    refreshToken: {
        type: 'string',
        description: 'Opaque; single-use (rotated on every refresh).',
    },
    expiresIn: { type: 'integer', description: 'Access token lifetime in seconds.' },
    tokenType: { type: 'string', const: 'Bearer' },
};
const commentFields: JsonObject = {
    id: uuid,
    projectId: uuid,
    taskId: { ...nullable(uuid), description: 'Null for a project-level comment.' },
    authorId: uuid,
    parentId: {
        ...nullable(uuid),
        description: 'The comment this replies to; null for a top-level comment.',
    },
    body: str,
    editedAt: nullable(dateTime),
    createdAt: dateTime,
    author: ref('UserSummary'),
    replyCount: {
        type: 'integer',
        minimum: 0,
        description: 'Direct replies to this comment; always 0 for a reply.',
    },
};
const projectSummaryFields: JsonObject = {
    id: uuid,
    name: str,
    description: nullable(str),
    createdAt: dateTime,
    updatedAt: dateTime,
    myRole: ref('ProjectRole'),
    memberCount: int,
};
const invitationFields: JsonObject = {
    id: uuid,
    projectId: uuid,
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['ADMIN', 'MEMBER'] },
    status: {
        ...ref('InvitationStatus'),
        description: 'A PENDING invitation past `expiresAt` is reported as EXPIRED.',
    },
    expiresAt: dateTime,
    respondedAt: nullable(dateTime),
    createdAt: dateTime,
    invitedBy: ref('UserSummary'),
};

const errorSchema = object({
    error: object(
        {
            code: { type: 'string', description: 'Stable machine-readable code.' },
            message: str,
            details: {
                type: 'array',
                description: 'Only on VALIDATION_ERROR.',
                items: object({ path: str, message: str }),
            },
            requestId: { type: 'string', description: 'Also sent as the `X-Request-Id` header.' },
        },
        ['details'],
    ),
});

const componentSchemas: JsonObject = {
    Error: errorSchema,
    PageMeta: object({ page: int, limit: int, total: int, totalPages: int }),
    NotificationPageMeta: object({
        page: int,
        limit: int,
        total: int,
        totalPages: int,
        unreadCount: { type: 'integer', description: 'Unread notifications in total.' },
    }),
    ProjectRole: enumOf(ProjectRole),
    InvitationStatus: enumOf(InvitationStatus),
    TaskStatus: enumOf(TaskStatus),
    TaskPriority: enumOf(TaskPriority),
    NotificationType: enumOf(NotificationType),
    Health: object({
        data: object({
            status: { type: 'string', enum: ['ok', 'degraded'] },
            db: { type: 'string', enum: ['ok', 'down'] },
        }),
    }),
    UserSummary: idName,
    UserContact: object({ id: uuid, name: str, email: { type: 'string', format: 'email' } }),
    User: object({
        id: uuid,
        email: { type: 'string', format: 'email' },
        name: str,
        bio: nullable(str),
        avatarUrl: nullable({ type: 'string', format: 'uri' }),
        createdAt: dateTime,
        updatedAt: dateTime,
    }),
    AuthTokens: object(tokenFields),
    LoginResult: object({ ...tokenFields, user: ref('User') }),
    ProjectSummary: object(projectSummaryFields),
    Project: object({
        ...projectSummaryFields,
        owner: { ...nullable(ref('UserContact')), description: 'The current OWNER.' },
    }),
    Member: object({
        user: object({
            id: uuid,
            name: str,
            email: { type: 'string', format: 'email' },
            avatarUrl: nullable({ type: 'string', format: 'uri' }),
        }),
        role: ref('ProjectRole'),
        joinedAt: dateTime,
    }),
    Invitation: object(invitationFields),
    MyInvitation: object({ ...invitationFields, project: idName }),
    InvitationAcceptance: object({ projectId: uuid, role: ref('ProjectRole') }),
    Task: object({
        ...taskFields,
        assignee: nullable(ref('UserContact')),
        createdBy: ref('UserContact'),
        commentCount: int,
        attachmentCount: int,
    }),
    TaskListItem: object({
        ...taskFields,
        assignee: nullable(ref('UserSummary')),
        createdBy: ref('UserSummary'),
    }),
    MyTaskListItem: object({
        ...taskFields,
        assignee: nullable(ref('UserSummary')),
        createdBy: ref('UserSummary'),
        project: idName,
    }),
    Comment: object(commentFields),
    CommentDetail: object({
        ...commentFields,
        task: nullable(object({ id: uuid, title: str, description: nullable(str) })),
        project: idName,
    }),
    Attachment: object({
        id: uuid,
        originalName: { type: 'string', description: 'Sanitised client filename.' },
        mimeType: str,
        sizeBytes: int,
        taskId: { ...nullable(uuid), description: 'Null for a project-level attachment.' },
        createdAt: dateTime,
        uploadedBy: ref('UserSummary'),
    }),
    Notification: object({
        id: uuid,
        type: ref('NotificationType'),
        projectId: nullable(uuid),
        taskId: nullable(uuid),
        payload: {
            type: 'object',
            additionalProperties: true,
            description:
                'Snapshot at event time: `actor { id, name }`, `project { id, name }`, `task { id, title }` for task events, plus `changedFields`, `commentId` + `commentPreview`, or `invitationId` + `role`.',
        },
        readAt: nullable(dateTime),
        createdAt: dateTime,
    }),
    TaskDescription: object({ description: str }),
};

const componentResponses: JsonObject = Object.fromEntries(
    Object.values(ERRORS).map(([name, description]) => [
        name,
        { description, content: json(ref('Error')) },
    ]),
);

// ---------------------------------------------------------------------------------------------
// Request bodies from the route schemas
// ---------------------------------------------------------------------------------------------

/** Update bodies use .refine(...) for "at least one field", which JSON Schema expresses directly. */
const atLeastOne = (schema: JsonObject): JsonObject => ({ ...schema, minProperties: 1 });

const bodies = {
    register: withProperties(jsonSchema(registerBodySchema), { email: EMAIL }),
    login: withProperties(jsonSchema(loginBodySchema), { email: EMAIL }),
    refreshToken: jsonSchema(refreshTokenBodySchema),
    updateMe: atLeastOne(jsonSchema(updateMeBodySchema)),
    changePassword: {
        ...jsonSchema(changePasswordBodySchema),
        description: '`newPassword` must differ from `currentPassword`.',
    },
    createProject: jsonSchema(createProjectBodySchema),
    updateProject: atLeastOne(jsonSchema(updateProjectBodySchema)),
    updateMemberRole: jsonSchema(updateMemberRoleBodySchema),
    createInvitation: withProperties(jsonSchema(createInvitationBodySchema), { email: EMAIL }),
    createTask: jsonSchema(createTaskBodySchema),
    updateTask: atLeastOne(jsonSchema(updateTaskBodySchema)),
    createComment: withProperties(jsonSchema(createCommentBodySchema), {
        parentId: {
            description:
                "Reply to this top-level comment. The reply takes the parent's `taskId`; null or omitted for a top-level comment.",
        },
    }),
    updateComment: jsonSchema(updateCommentBodySchema),
    taskDescription: jsonSchema(taskDescriptionBodySchema),
};

const uploadFields = jsonSchema(uploadAttachmentBodySchema);
const uploadBody: JsonObject = {
    required: true,
    content: {
        'multipart/form-data': {
            schema: {
                type: 'object',
                required: ['file'],
                properties: {
                    file: {
                        type: 'string',
                        format: 'binary',
                        contentMediaType: 'application/octet-stream',
                        description:
                            'Exactly one file. Allowed types: PNG, JPEG, GIF, WebP, PDF, plain text, CSV, zip, Word, Excel.',
                    },
                    ...(isObject(uploadFields.properties) ? uploadFields.properties : {}),
                },
                additionalProperties: false,
            },
        },
    },
};

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

const V1 = '/api/v1';

function buildPaths(): JsonObject {
    const projectPath = `${V1}/projects/{projectId}`;
    return {
        '/health': {
            get: operation({
                operationId: 'getHealth',
                tag: 'Health',
                summary: 'Liveness and database check',
                isPublic: true,
                responses: {
                    200: { description: 'API and database are up', content: json(ref('Health')) },
                    503: {
                        description: 'Database unreachable (`status: degraded`, `db: down`)',
                        content: json(ref('Health')),
                    },
                },
            }),
        },

        // Auth -------------------------------------------------------------------------------
        [`${V1}/auth/register`]: {
            post: operation({
                operationId: 'register',
                tag: 'Auth',
                summary: 'Create an account',
                description:
                    'Does not log in. Email is trimmed and lowercased. Rate limited to 10/min per IP.',
                isPublic: true,
                requestBody: jsonBody(bodies.register),
                responses: {
                    201: okResponse('The new user', ref('User')),
                    ...errors(409, 422, 429),
                },
            }),
        },
        [`${V1}/auth/login`]: {
            post: operation({
                operationId: 'login',
                tag: 'Auth',
                summary: 'Log in',
                description:
                    'Unknown email and wrong password both return 401 `INVALID_CREDENTIALS`. Rate limited to 10/min per IP.',
                isPublic: true,
                requestBody: jsonBody(bodies.login),
                responses: {
                    200: okResponse('Tokens and the user', ref('LoginResult')),
                    ...errors(401, 422, 429),
                },
            }),
        },
        [`${V1}/auth/refresh`]: {
            post: operation({
                operationId: 'refreshTokens',
                tag: 'Auth',
                summary: 'Exchange a refresh token for a new pair',
                description:
                    "Rotates the token. Reusing an already-rotated token revokes all of the user's sessions (401). Rate limited to 10/min per IP.",
                isPublic: true,
                requestBody: jsonBody(bodies.refreshToken),
                responses: {
                    200: okResponse('A new token pair', ref('AuthTokens')),
                    ...errors(401, 422, 429),
                },
            }),
        },
        [`${V1}/auth/logout`]: {
            post: operation({
                operationId: 'logout',
                tag: 'Auth',
                summary: 'Revoke one refresh token',
                description: 'Idempotent: an unknown or already-revoked token is still 204.',
                isPublic: true,
                requestBody: jsonBody(bodies.refreshToken),
                responses: { 204: noContent('Logged out'), ...errors(422, 429) },
            }),
        },
        [`${V1}/auth/logout-all`]: {
            post: operation({
                operationId: 'logoutAll',
                tag: 'Auth',
                summary: 'Revoke every refresh token of the current user',
                responses: { 204: noContent('All sessions ended'), ...errors(401, 429) },
            }),
        },

        // Users ------------------------------------------------------------------------------
        [`${V1}/users/me`]: {
            get: operation({
                operationId: 'getMe',
                tag: 'Users',
                summary: 'My profile',
                responses: { 200: okResponse('The current user', ref('User')), ...errors(401) },
            }),
            patch: operation({
                operationId: 'updateMe',
                tag: 'Users',
                summary: 'Update my profile',
                description: 'At least one field. `null` clears `bio` or `avatarUrl`.',
                requestBody: jsonBody(bodies.updateMe),
                responses: {
                    200: okResponse('The updated user', ref('User')),
                    ...errors(401, 422),
                },
            }),
        },
        [`${V1}/users/me/password`]: {
            patch: operation({
                operationId: 'changePassword',
                tag: 'Users',
                summary: 'Change my password',
                description:
                    'Signs out every session. A wrong current password is 400 `INVALID_CURRENT_PASSWORD` (not 401).',
                requestBody: jsonBody(bodies.changePassword),
                responses: { 204: noContent('Password changed'), ...errors(400, 401, 422) },
            }),
        },
        [`${V1}/users/me/invitations`]: {
            get: operation({
                operationId: 'listMyInvitations',
                tag: 'Users',
                summary: 'My pending, unexpired invitations',
                responses: {
                    200: okResponse('Newest first', { type: 'array', items: ref('MyInvitation') }),
                    ...errors(401),
                },
            }),
        },
        [`${V1}/users/me/tasks`]: {
            get: operation({
                operationId: 'listMyTasks',
                tag: 'Users',
                summary: 'Tasks assigned to me across my projects',
                description:
                    'Same filters, sorting and paging as the project task list, except `assignee`.',
                parameters: queryParams(myTasksQuerySchema, TASK_LIST_DOCS),
                responses: {
                    200: pageResponse('A page of my tasks', ref('MyTaskListItem')),
                    ...errors(401, 422),
                },
            }),
        },

        // Projects ---------------------------------------------------------------------------
        [`${V1}/projects`]: {
            post: operation({
                operationId: 'createProject',
                tag: 'Projects',
                summary: 'Create a project',
                description: 'The caller becomes its OWNER.',
                requestBody: jsonBody(bodies.createProject),
                responses: {
                    201: okResponse('The new project', ref('Project')),
                    ...errors(401, 422),
                },
            }),
            get: operation({
                operationId: 'listMyProjects',
                tag: 'Projects',
                summary: 'Projects I belong to',
                description: 'Most recently updated first.',
                parameters: queryParams(paginationQuerySchema, PAGINATION_DOCS),
                responses: {
                    200: pageResponse('A page of projects', ref('ProjectSummary')),
                    ...errors(401, 422),
                },
            }),
        },
        [projectPath]: {
            parameters: [PROJECT_ID],
            get: operation({
                operationId: 'getProject',
                tag: 'Projects',
                summary: 'Get a project',
                description: 'Any member. Non-members get 404.',
                responses: {
                    200: okResponse('The project', ref('Project')),
                    ...errors(401, 404, 422),
                },
            }),
            patch: operation({
                operationId: 'updateProject',
                tag: 'Projects',
                summary: 'Update a project',
                description: 'ADMIN or OWNER. At least one field.',
                requestBody: jsonBody(bodies.updateProject),
                responses: {
                    200: okResponse('The updated project', ref('Project')),
                    ...errors(401, 403, 404, 422),
                },
            }),
            delete: operation({
                operationId: 'deleteProject',
                tag: 'Projects',
                summary: 'Delete a project',
                description:
                    'OWNER only. Deletes its members, invitations, tasks, comments and attachments (files included).',
                responses: { 204: noContent('Deleted'), ...errors(401, 403, 404, 422) },
            }),
        },

        // Members ----------------------------------------------------------------------------
        [`${projectPath}/members`]: {
            parameters: [PROJECT_ID],
            get: operation({
                operationId: 'listMembers',
                tag: 'Members',
                summary: 'List members',
                description: 'OWNER, then ADMINs, then MEMBERs, each by join date.',
                responses: {
                    200: okResponse('All members', { type: 'array', items: ref('Member') }),
                    ...errors(401, 404, 422),
                },
            }),
        },
        [`${projectPath}/members/{userId}`]: {
            parameters: [PROJECT_ID, pathParam('userId', "Member's user id")],
            patch: operation({
                operationId: 'changeMemberRole',
                tag: 'Members',
                summary: "Change a member's role",
                description:
                    'OWNER only. `role: OWNER` transfers ownership (the current owner becomes ADMIN). Changing your own role is 409.',
                requestBody: jsonBody(bodies.updateMemberRole),
                responses: {
                    200: okResponse('The updated member list', {
                        type: 'array',
                        items: ref('Member'),
                    }),
                    ...errors(401, 403, 404, 409, 422),
                },
            }),
            delete: operation({
                operationId: 'removeMember',
                tag: 'Members',
                summary: 'Remove a member, or leave',
                description:
                    'Your own id = leave (the OWNER gets 409 and must transfer first). ADMIN removes MEMBERs; OWNER removes ADMINs and MEMBERs. Their open tasks are unassigned.',
                responses: { 204: noContent('Removed'), ...errors(401, 403, 404, 409, 422) },
            }),
        },

        // Invitations ------------------------------------------------------------------------
        [`${projectPath}/invitations`]: {
            parameters: [PROJECT_ID],
            post: operation({
                operationId: 'createInvitation',
                tag: 'Invitations',
                summary: 'Invite by email',
                description:
                    'ADMIN or OWNER; only the OWNER can invite with role ADMIN. Expires after `INVITATION_TTL_DAYS`.',
                requestBody: jsonBody(bodies.createInvitation),
                responses: {
                    201: okResponse('The invitation', ref('Invitation')),
                    ...errors(401, 403, 404, 409, 422),
                },
            }),
            get: operation({
                operationId: 'listProjectInvitations',
                tag: 'Invitations',
                summary: "List a project's invitations",
                description:
                    'ADMIN or OWNER. Newest first. `status` filters by the reported status (lapsed PENDING = EXPIRED).',
                parameters: queryParams(listInvitationsQuerySchema, PAGINATION_DOCS),
                responses: {
                    200: pageResponse('A page of invitations', ref('Invitation')),
                    ...errors(401, 403, 404, 422),
                },
            }),
        },
        [`${projectPath}/invitations/{invitationId}`]: {
            parameters: [PROJECT_ID, pathParam('invitationId', 'Invitation id')],
            delete: operation({
                operationId: 'revokeInvitation',
                tag: 'Invitations',
                summary: 'Revoke a pending invitation',
                description: 'ADMIN or OWNER. Only an unexpired PENDING invitation (else 409).',
                responses: { 204: noContent('Revoked'), ...errors(401, 403, 404, 409, 422) },
            }),
        },
        [`${V1}/invitations/{invitationId}/accept`]: {
            parameters: [pathParam('invitationId', 'Invitation id')],
            post: operation({
                operationId: 'acceptInvitation',
                tag: 'Invitations',
                summary: 'Accept an invitation',
                description:
                    'Invitee only (email must match; otherwise 404). Not pending → 409, expired → 410, already a member → 409.',
                responses: {
                    200: okResponse('You are now a member', ref('InvitationAcceptance')),
                    ...errors(401, 404, 409, 410, 422),
                },
            }),
        },
        [`${V1}/invitations/{invitationId}/decline`]: {
            parameters: [pathParam('invitationId', 'Invitation id')],
            post: operation({
                operationId: 'declineInvitation',
                tag: 'Invitations',
                summary: 'Decline an invitation',
                description: 'Invitee only (otherwise 404). Not pending → 409, expired → 410.',
                responses: { 204: noContent('Declined'), ...errors(401, 404, 409, 410, 422) },
            }),
        },

        // Tasks ------------------------------------------------------------------------------
        [`${projectPath}/tasks`]: {
            parameters: [PROJECT_ID],
            post: operation({
                operationId: 'createTask',
                tag: 'Tasks',
                summary: 'Create a task',
                description:
                    'Any member. Starts OPEN. `assigneeId` must be a member of this project (else 422 on `assigneeId`).',
                requestBody: jsonBody(bodies.createTask),
                responses: {
                    201: okResponse('The new task', ref('Task')),
                    ...errors(401, 404, 422),
                },
            }),
            get: operation({
                operationId: 'listTasks',
                tag: 'Tasks',
                summary: 'List, filter, search and sort tasks',
                description: 'Any member. Unknown query params → 422.',
                parameters: queryParams(taskListQuerySchema, TASK_LIST_DOCS),
                responses: {
                    200: pageResponse('A page of tasks', ref('TaskListItem')),
                    ...errors(401, 404, 422),
                },
            }),
        },
        [`${projectPath}/tasks/{taskId}`]: {
            parameters: [PROJECT_ID, pathParam('taskId', 'Task id')],
            get: operation({
                operationId: 'getTask',
                tag: 'Tasks',
                summary: 'Get a task',
                responses: { 200: okResponse('The task', ref('Task')), ...errors(401, 404, 422) },
            }),
            patch: operation({
                operationId: 'updateTask',
                tag: 'Tasks',
                summary: 'Update, assign or complete a task',
                description:
                    'Creator, assignee, or ADMIN+. `{ "status": "COMPLETED" }` completes it (sets `completedAt`); `assigneeId: null` unassigns. Checks: 404 → 403 → 422. 409 if the status changed concurrently.',
                requestBody: jsonBody(bodies.updateTask),
                responses: {
                    200: okResponse('The updated task', ref('Task')),
                    ...errors(401, 403, 404, 409, 422),
                },
            }),
            delete: operation({
                operationId: 'deleteTask',
                tag: 'Tasks',
                summary: 'Delete a task',
                description:
                    'Creator or ADMIN+. Deletes its comments and attachments (files included).',
                responses: { 204: noContent('Deleted'), ...errors(401, 403, 404, 422) },
            }),
        },

        // Comments ---------------------------------------------------------------------------
        [`${projectPath}/comments`]: {
            parameters: [PROJECT_ID],
            post: operation({
                operationId: 'createComment',
                tag: 'Comments',
                summary: 'Comment on the project or one of its tasks, or reply to a comment',
                description: [
                    "Any member. A `taskId` that isn't in this project → 404.",
                    '',
                    "**Replies** (`parentId`): one level only, so replying to a reply → 422. A reply inherits the parent's `taskId`; an explicit `taskId` that differs from the parent's → 422. A parent that is missing or in another project → 404.",
                ].join('\n'),
                requestBody: jsonBody(bodies.createComment),
                responses: {
                    201: okResponse('The new comment', ref('Comment')),
                    ...errors(401, 404, 422),
                },
            }),
            get: operation({
                operationId: 'listComments',
                tag: 'Comments',
                summary: 'List comments',
                description:
                    "Any member. Oldest first by default; order=desc for newest first. parentId=none → top-level comments only; parentId=<id> → that comment's replies.",
                parameters: queryParams(listCommentsQuerySchema, COMMENT_LIST_DOCS),
                responses: {
                    200: pageResponse('A page of comments', ref('Comment')),
                    ...errors(401, 404, 422),
                },
            }),
        },
        [`${projectPath}/comments/{commentId}`]: {
            parameters: [PROJECT_ID, pathParam('commentId', 'Comment id')],
            get: operation({
                operationId: 'getComment',
                tag: 'Comments',
                summary: 'Get a comment',
                responses: {
                    200: okResponse(
                        'The comment with task and project summaries',
                        ref('CommentDetail'),
                    ),
                    ...errors(401, 404, 422),
                },
            }),
            patch: operation({
                operationId: 'updateComment',
                tag: 'Comments',
                summary: 'Edit a comment',
                description:
                    'Author only (not even the OWNER). Sets `editedAt`. Checks: 404 → 403 → 422.',
                requestBody: jsonBody(bodies.updateComment),
                responses: {
                    200: okResponse('The updated comment', ref('Comment')),
                    ...errors(401, 403, 404, 422),
                },
            }),
            delete: operation({
                operationId: 'deleteComment',
                tag: 'Comments',
                summary: 'Delete a comment',
                description:
                    'Author or ADMIN+. Deleting a top-level comment also deletes its replies.',
                responses: { 204: noContent('Deleted'), ...errors(401, 403, 404, 422) },
            }),
        },
        [`${projectPath}/comments/{commentId}/replies`]: {
            parameters: [PROJECT_ID, pathParam('commentId', 'Top-level comment id')],
            get: operation({
                operationId: 'listCommentReplies',
                tag: 'Comments',
                summary: "List a comment's replies",
                description:
                    'Any member. Oldest first by default; order=desc for newest first. A comment that is missing or in another project → 404; a comment that is itself a reply → 422 on `commentId`. Unknown query params → 422.',
                parameters: queryParams(listRepliesQuerySchema, COMMENT_REPLIES_DOCS),
                responses: {
                    200: pageResponse('A page of replies', ref('Comment')),
                    ...errors(401, 404, 422),
                },
            }),
        },

        // Attachments ------------------------------------------------------------------------
        [`${projectPath}/attachments`]: {
            parameters: [PROJECT_ID],
            post: operation({
                operationId: 'uploadAttachment',
                tag: 'Attachments',
                summary: 'Upload a file to the project or one of its tasks',
                description:
                    'Any member. One file in the `file` field, up to `MAX_UPLOAD_MB`. A second file or another file field → 400. A `taskId` not in this project → 404 (nothing is stored).',
                requestBody: uploadBody,
                responses: {
                    201: okResponse('The attachment metadata', ref('Attachment')),
                    ...errors(400, 401, 404, 413, 415, 422),
                },
            }),
            get: operation({
                operationId: 'listAttachments',
                tag: 'Attachments',
                summary: 'List attachments (metadata only)',
                description: 'Any member. Newest first.',
                parameters: queryParams(listAttachmentsQuerySchema, TASK_ID_FILTER),
                responses: {
                    200: pageResponse('A page of attachments', ref('Attachment')),
                    ...errors(401, 404, 422),
                },
            }),
        },
        [`${projectPath}/attachments/{attachmentId}`]: {
            parameters: [PROJECT_ID, pathParam('attachmentId', 'Attachment id')],
            get: operation({
                operationId: 'getAttachment',
                tag: 'Attachments',
                summary: 'Get attachment metadata',
                responses: {
                    200: okResponse('The attachment metadata', ref('Attachment')),
                    ...errors(401, 404, 422),
                },
            }),
            delete: operation({
                operationId: 'deleteAttachment',
                tag: 'Attachments',
                summary: 'Delete an attachment',
                description: 'Uploader or ADMIN+. The stored file is removed too.',
                responses: { 204: noContent('Deleted'), ...errors(401, 403, 404, 422) },
            }),
        },
        [`${projectPath}/attachments/{attachmentId}/download`]: {
            parameters: [PROJECT_ID, pathParam('attachmentId', 'Attachment id')],
            get: operation({
                operationId: 'downloadAttachment',
                tag: 'Attachments',
                summary: 'Download the file',
                description:
                    'Any member. Served as a download with the stored MIME type. 404 if the row exists but the file is missing from storage.',
                responses: {
                    200: {
                        description: 'The file bytes',
                        headers: {
                            'Content-Disposition': {
                                description:
                                    "`attachment` with the original filename (`filename*=UTF-8''…` for non-ASCII names).",
                                schema: str,
                            },
                            'Content-Length': { schema: int },
                        },
                        content: {
                            'application/octet-stream': {
                                schema: {
                                    type: 'string',
                                    format: 'binary',
                                    description:
                                        'The actual `Content-Type` is the type stored at upload.',
                                },
                            },
                        },
                    },
                    ...errors(401, 404, 422),
                },
            }),
        },

        // Notifications ----------------------------------------------------------------------
        [`${V1}/notifications`]: {
            get: operation({
                operationId: 'listNotifications',
                tag: 'Notifications',
                summary: 'My notifications',
                description:
                    'Newest first. `meta.unreadCount` counts all unread, regardless of filter.',
                parameters: queryParams(listNotificationsQuerySchema, {
                    ...PAGINATION_DOCS,
                    unread: { description: '`true` for unread only, `false` for read only.' },
                }),
                responses: {
                    200: pageResponse(
                        'A page of notifications',
                        ref('Notification'),
                        'NotificationPageMeta',
                    ),
                    ...errors(401, 422),
                },
            }),
        },
        [`${V1}/notifications/stream`]: {
            get: operation({
                operationId: 'streamNotifications',
                tag: 'Notifications',
                summary: 'Live notifications (Server-Sent Events)',
                description: [
                    'Keeps the connection open and sends:',
                    '',
                    '- `event: ready` once connected;',
                    '- `id: <notificationId>`, `event: notification`, `data: <Notification JSON>` for each new notification;',
                    '- a `: ping` comment every 25 s to keep proxies from closing the connection.',
                    '',
                    "Swagger UI can't display a live stream; use `curl -N -H \"Authorization: Bearer <token>\" http://localhost:3000/api/v1/notifications/stream` or Postman. Browsers' `EventSource` can't send the Authorization header; use a fetch-based reader.",
                ].join('\n'),
                responses: {
                    200: {
                        description: 'An open event stream',
                        content: { 'text/event-stream': { schema: str } },
                    },
                    ...errors(401),
                },
            }),
        },
        [`${V1}/notifications/{notificationId}/read`]: {
            parameters: [pathParam('notificationId', 'Notification id')],
            patch: operation({
                operationId: 'markNotificationRead',
                tag: 'Notifications',
                summary: 'Mark one notification read',
                description: "Idempotent; keeps the first `readAt`. Someone else's → 404.",
                responses: { 204: noContent('Marked read'), ...errors(401, 404, 422) },
            }),
        },
        [`${V1}/notifications/read-all`]: {
            post: operation({
                operationId: 'markAllNotificationsRead',
                tag: 'Notifications',
                summary: 'Mark all my notifications read',
                responses: { 204: noContent('All marked read'), ...errors(401) },
            }),
        },

        // AI ---------------------------------------------------------------------------------
        [`${V1}/ai/task-description`]: {
            post: operation({
                operationId: 'suggestTaskDescription',
                tag: 'AI',
                summary: 'Suggest a task description',
                description:
                    'Returns a goal sentence plus 3–6 acceptance criteria. Only suggests text; nothing is saved. 10 requests/min per user. Uses the provider configured in `.env` (Anthropic or Gemini).',
                requestBody: jsonBody(bodies.taskDescription),
                responses: {
                    200: okResponse('The suggested description', ref('TaskDescription')),
                    ...errors(401, 422, 429, 502, 503),
                },
            }),
        },
    };
}

function packageVersion(): string {
    // Read at runtime: the build's rootDir is src/, so package.json can't be imported.
    // Same relative path from src/docs (tsx) and dist/docs (compiled).
    const raw: unknown = JSON.parse(
        readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
    );
    return z.object({ version: z.string() }).parse(raw).version;
}

export function buildOpenApiDocument(): JsonObject {
    return {
        openapi: '3.1.0',
        info: {
            title: 'TaskMaster API',
            version: packageVersion(),
            description:
                'Collaborative task-tracking REST API: projects, members and invitations, tasks, comments, attachments, notifications and AI task descriptions. Setup, permissions and limitations are in the [README](https://github.com/utkarsh-vats/Airtribe_TaskMaster#readme). Every response is `{ data }` (plus `meta` on lists) or `{ error: { code, message, details?, requestId } }`.',
        },
        servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
        security: [{ bearerAuth: [] }],
        tags: [
            { name: 'Health' },
            { name: 'Auth', description: 'Accounts and tokens' },
            { name: 'Users', description: 'The current user' },
            { name: 'Projects' },
            { name: 'Members', description: 'Project membership and roles' },
            { name: 'Invitations' },
            { name: 'Tasks' },
            { name: 'Comments', description: 'Project-level or task-level comments' },
            { name: 'Attachments', description: 'Project-level or task-level files' },
            { name: 'Notifications' },
            { name: 'AI', description: 'Optional; needs a configured provider' },
        ],
        paths: buildPaths(),
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                    description: 'The `accessToken` from login or refresh.',
                },
            },
            schemas: componentSchemas,
            responses: componentResponses,
        },
    };
}

/** Built once at startup. */
export const openApiDocument = buildOpenApiDocument();
