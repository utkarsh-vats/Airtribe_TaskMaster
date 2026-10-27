import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env';
import { openApiDocument } from './docs/openapi';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { healthRouter } from './modules/health/health.routes';
import { registerNotificationListeners } from './modules/notifications/notifications.listener';
import { apiRouter } from './routes';

/** Builds the Express app without listening, so tests can drive it with supertest. */
export function createApp() {
    const app = express();

    // Idempotent, so building several apps (as the tests do) doesn't duplicate listeners.
    registerNotificationListeners();

    app.use(
        pinoHttp({
            logger,
            // Reuse an incoming X-Request-Id (e.g. from a gateway) or mint one, and echo it back.
            genReqId: (req, res) => {
                const incoming = req.headers['x-request-id'];
                const id =
                    typeof incoming === 'string' && incoming.length <= 100
                        ? incoming
                        : randomUUID();
                res.setHeader('X-Request-Id', id);
                return id;
            },
        }),
    );
    app.use(helmet());
    app.use(
        cors({
            origin: env.CORS_ORIGIN === '*' ? '*' : env.CORS_ORIGIN.split(',').map((o) => o.trim()),
        }),
    );
    app.use(express.json({ limit: '1mb' }));

    app.use(healthRouter);

    // API docs, outside /api/v1 and without auth. Swagger UI only loads same-origin scripts,
    // so helmet's default CSP doesn't need relaxing.
    app.get('/openapi.json', (_req, res) => {
        res.json(openApiDocument);
    });
    app.use(
        '/docs',
        swaggerUi.serve,
        swaggerUi.setup(openApiDocument, { customSiteTitle: 'TaskMaster API docs' }),
    );
    app.use('/api/v1', apiRouter);

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}
