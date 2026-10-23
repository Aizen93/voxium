export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    // The prototype of the class being constructed, not AppError's: pinned
    // to AppError.prototype, every subclass instance WAS an AppError only,
    // and `err instanceof ForbiddenError` never matched anywhere (the two
    // catch blocks that asked fell through to their generic answer)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message: string) {
    super(message, 415);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests. Please try again later.') {
    super(message, 429);
  }
}

/** The server cannot serve this request as configured (e.g. a missing encryption key). */
export class ServiceUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 503);
  }
}

/** Prisma's error code (`P2025`, `P2003`, ...) when the error carries one. */
export function prismaErrorCode(err: unknown): string | undefined {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** Parse a date string query parameter, throwing BadRequestError if invalid. */
export function parseDateParam(value: string, name = 'date'): Date {
  const date = new Date(value);
  if (isNaN(date.getTime())) throw new BadRequestError(`Invalid ${name} parameter`);
  return date;
}
