import type { RequestHandler } from 'express';
import multer, { MulterError } from 'multer';
import { env } from '../config/env';
import { AppError, BadRequestError, UnsupportedMediaTypeError } from '../lib/errors';

/** Client-declared MIME types we accept (DESIGN §4). No magic-byte sniffing. */
export const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/**
 * One file in the multipart field `file`, buffered in memory, on `req.file`. Text fields land
 * on `req.body`. Size/count errors are MulterErrors (mapped in errorHandler); a disallowed type
 * is 415; any other parse failure (e.g. a truncated body) becomes 400.
 */
export function createUploadMiddleware({ maxBytes }: { maxBytes: number }): RequestHandler {
    const handler = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxBytes, files: 1 },
        // Filenames are sent as raw UTF-8; multer's default (latin1) would garble "résumé.pdf".
        defParamCharset: 'utf8',
        fileFilter: (_req, file, cb) => {
            if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new UnsupportedMediaTypeError(`File type ${file.mimetype} is not allowed`));
            }
        },
    }).single('file');

    return (req, res, next) => {
        handler(req, res, (err?: unknown) => {
            if (err === undefined || err instanceof AppError || err instanceof MulterError) {
                next(err);
            } else {
                next(new BadRequestError('Invalid multipart body'));
            }
        });
    };
}

export const uploadSingleFile = createUploadMiddleware({
    maxBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
});
