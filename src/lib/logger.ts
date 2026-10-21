import { pino } from 'pino';
import { env } from '../config/env';

// Tests are silent unless LOG_LEVEL is set explicitly (e.g. LOG_LEVEL=error to see 500s).
// Checked on process.env because env.LOG_LEVEL always has a value once the default applies.
const silentInTest = env.NODE_ENV === 'test' && process.env.LOG_LEVEL === undefined;

export const logger = pino({
    level: silentInTest ? 'silent' : env.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
});
