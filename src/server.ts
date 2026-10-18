import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './db/prisma';
import { logger } from './lib/logger';

const app = createApp();

const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'TaskMaster API listening');
});

server.on('error', (err) => {
    logger.fatal({ err }, 'Server failed to start');
    process.exit(1);
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    // Stop accepting connections, let in-flight requests finish, then close the DB pool.
    server.close((err) => {
        void prisma.$disconnect().finally(() => process.exit(err ? 1 : 0));
    });

    // Hard stop if something keeps the process alive (e.g. open SSE streams).
    setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
