import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './db/prisma';
import { logger } from './lib/logger';
import { closeAllStreams } from './modules/notifications/sse';

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

    // SSE streams never finish on their own; end them so server.close() isn't held open.
    closeAllStreams();

    // Stop accepting connections, let in-flight requests finish, then close the DB pool.
    server.close((err) => {
        void prisma.$disconnect().finally(() => process.exit(err ? 1 : 0));
    });

    // Hard stop if something still keeps the process alive.
    setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
