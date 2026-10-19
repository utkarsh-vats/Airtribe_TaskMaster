/**
 * Application error hierarchy. Services throw these; the error middleware turns them into
 * `{ error: { code, message, details?, requestId } }` responses with the matching HTTP status.
 */
export class AppError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = new.target.name;
    }
}

export class BadRequestError extends AppError {
    constructor(message = 'Bad request', details?: unknown) {
        super(400, 'BAD_REQUEST', message, details);
    }
}

/** 400, not 401: a wrong current password must not look like an expired session to clients. */
export class InvalidCurrentPasswordError extends AppError {
    constructor(message = 'Current password is incorrect') {
        super(400, 'INVALID_CURRENT_PASSWORD', message);
    }
}

export class UnauthorizedError extends AppError {
    constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
        super(401, code, message);
    }
}

export class ForbiddenError extends AppError {
    constructor(message = 'You do not have permission to perform this action') {
        super(403, 'FORBIDDEN', message);
    }
}

export class NotFoundError extends AppError {
    constructor(resource = 'Resource') {
        super(404, 'NOT_FOUND', `${resource} not found`);
    }
}

export class ConflictError extends AppError {
    constructor(message = 'Conflict with the current state of the resource') {
        super(409, 'CONFLICT', message);
    }
}

export class GoneError extends AppError {
    constructor(message = 'This resource is no longer available', code = 'GONE') {
        super(410, code, message);
    }
}

export class PayloadTooLargeError extends AppError {
    constructor(message = 'Payload too large') {
        super(413, 'PAYLOAD_TOO_LARGE', message);
    }
}

export class UnsupportedMediaTypeError extends AppError {
    constructor(message = 'Unsupported media type') {
        super(415, 'UNSUPPORTED_MEDIA_TYPE', message);
    }
}

export class TooManyRequestsError extends AppError {
    constructor(message = 'Too many requests, please try again later') {
        super(429, 'RATE_LIMITED', message);
    }
}

export interface ValidationIssue {
    path: string;
    message: string;
}

export class ValidationError extends AppError {
    constructor(details: ValidationIssue[], message = 'Request validation failed') {
        super(422, 'VALIDATION_ERROR', message, details);
    }
}
