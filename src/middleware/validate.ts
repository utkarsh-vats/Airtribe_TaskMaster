import type { Request, RequestHandler } from 'express';
import type { z } from 'zod';

export type RequestPart = 'body' | 'params' | 'query';

type PartSchemas = Partial<Record<RequestPart, z.ZodType>>;

const PARTS: readonly RequestPart[] = ['body', 'params', 'query'];

/**
 * Parses the given request parts with Zod and stores the results on `req.validated`.
 * Express 5's `req.query` is a read-only getter, so the originals are left untouched.
 * A failure is passed to the error middleware as a ZodError (→ 422 VALIDATION_ERROR).
 */
export function validate(schemas: PartSchemas): RequestHandler {
    return (req, _res, next) => {
        const validated: NonNullable<Request['validated']> = {};

        for (const part of PARTS) {
            const schema = schemas[part];
            if (!schema) continue;

            const result = schema.safeParse(req[part]);
            if (!result.success) {
                next(result.error);
                return;
            }
            validated[part] = result.data;
        }

        req.validated = validated;
        next();
    };
}

/**
 * Typed read of a part parsed by `validate()`. Pass the same schema used in the route so the
 * return type follows it: `getValidated(req, 'body', loginSchema)`.
 */
export function getValidated<S extends z.ZodType>(
    req: Request,
    part: RequestPart,
    _schema: S,
): z.output<S> {
    if (!req.validated || !(part in req.validated)) {
        throw new Error(
            `Request ${part} was not validated; add validate({ ${part} }) to the route`,
        );
    }
    return req.validated[part] as z.output<S>;
}
