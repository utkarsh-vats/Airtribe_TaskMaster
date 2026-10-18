import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import {
    AppError,
    BadRequestError,
    ConflictError,
    NotFoundError,
    PayloadTooLargeError,
    ValidationError,
} from '../lib/errors';

/** Catch-all for routes that matched nothing. Mounted after every router. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path}`));
};

/** Errors thrown by express.json() (body-parser) carry a string `type`. */
function isBodyParserError(err: unknown): err is { type: string } {
    return (
        typeof err === 'object' &&
        err !== null &&
        'type' in err &&
        typeof (err as { type: unknown }).type === 'string'
    );
}

function toAppError(err: unknown): AppError {
    if (err instanceof AppError) return err;

    if (err instanceof ZodError) {
        return new ValidationError(
            err.issues.map((issue) => ({
                path: issue.path.map(String).join('.'),
                message: issue.message,
            })),
        );
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2002')
            return new ConflictError('A record with these values already exists');
        if (err.code === 'P2025') return new NotFoundError();
    }

    if (isBodyParserError(err)) {
        if (err.type === 'entity.parse.failed') return new BadRequestError('Malformed JSON body');
        if (err.type === 'entity.too.large')
            return new PayloadTooLargeError('Request body too large');
    }

    return new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
}

// Express recognises error handlers by their 4-argument signature, so `_next` must stay.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    const appError = toAppError(err);

    if (appError.status >= 500) {
        req.log.error({ err }, 'Unhandled error');
    }

    res.status(appError.status).json({
        error: {
            code: appError.code,
            message: appError.message,
            ...(appError.details !== undefined ? { details: appError.details } : {}),
            requestId: String(req.id),
        },
    });
};
