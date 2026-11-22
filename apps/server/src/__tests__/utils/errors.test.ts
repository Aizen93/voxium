import { describe, it, expect } from 'vitest';
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  UnsupportedMediaTypeError,
  ServiceUnavailableError,
  parseDateParam,
  violatesUniqueIndex,
} from '../../utils/errors';

describe('AppError', () => {
  it('sets message and statusCode', () => {
    const err = new AppError('something went wrong', 500);
    expect(err.message).toBe('something went wrong');
    expect(err.statusCode).toBe(500);
  });

  it('sets isOperational to true', () => {
    const err = new AppError('test', 400);
    expect(err.isOperational).toBe(true);
  });

  it('is an instance of Error', () => {
    const err = new AppError('test', 500);
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of AppError', () => {
    const err = new AppError('test', 500);
    expect(err).toBeInstanceOf(AppError);
  });
});

describe('BadRequestError', () => {
  it('has statusCode 400', () => {
    const err = new BadRequestError('bad input');
    expect(err.statusCode).toBe(400);
  });

  it('sets the provided message', () => {
    const err = new BadRequestError('invalid field');
    expect(err.message).toBe('invalid field');
  });

  it('is an instance of AppError', () => {
    expect(new BadRequestError('x')).toBeInstanceOf(AppError);
  });

  it('is operational', () => {
    expect(new BadRequestError('x').isOperational).toBe(true);
  });
});

describe('UnauthorizedError', () => {
  it('has statusCode 401', () => {
    const err = new UnauthorizedError();
    expect(err.statusCode).toBe(401);
  });

  it('uses default message "Unauthorized"', () => {
    const err = new UnauthorizedError();
    expect(err.message).toBe('Unauthorized');
  });

  it('accepts a custom message', () => {
    const err = new UnauthorizedError('Token expired');
    expect(err.message).toBe('Token expired');
  });

  it('is an instance of AppError', () => {
    expect(new UnauthorizedError()).toBeInstanceOf(AppError);
  });
});

describe('ForbiddenError', () => {
  it('has statusCode 403', () => {
    const err = new ForbiddenError();
    expect(err.statusCode).toBe(403);
  });

  it('uses default message "Forbidden"', () => {
    const err = new ForbiddenError();
    expect(err.message).toBe('Forbidden');
  });

  it('accepts a custom message', () => {
    const err = new ForbiddenError('No permission');
    expect(err.message).toBe('No permission');
  });

  it('is an instance of AppError', () => {
    expect(new ForbiddenError()).toBeInstanceOf(AppError);
  });
});

describe('NotFoundError', () => {
  it('has statusCode 404', () => {
    const err = new NotFoundError('Channel');
    expect(err.statusCode).toBe(404);
  });

  it('formats message as "{resource} not found"', () => {
    const err = new NotFoundError('Server');
    expect(err.message).toBe('Server not found');
  });

  it('is an instance of AppError', () => {
    expect(new NotFoundError('User')).toBeInstanceOf(AppError);
  });
});

describe('ConflictError', () => {
  it('has statusCode 409', () => {
    const err = new ConflictError('Already exists');
    expect(err.statusCode).toBe(409);
  });

  it('sets the provided message', () => {
    const err = new ConflictError('Duplicate entry');
    expect(err.message).toBe('Duplicate entry');
  });

  it('is an instance of AppError', () => {
    expect(new ConflictError('x')).toBeInstanceOf(AppError);
  });
});

describe('UnsupportedMediaTypeError', () => {
  it('has statusCode 415 and the provided message', () => {
    const err = new UnsupportedMediaTypeError('Send application/json');
    expect(err.statusCode).toBe(415);
    expect(err.message).toBe('Send application/json');
  });

  it('is an operational AppError', () => {
    const err = new UnsupportedMediaTypeError('x');
    expect(err).toBeInstanceOf(AppError);
    expect(err.isOperational).toBe(true);
  });
});

describe('ServiceUnavailableError', () => {
  it('has statusCode 503 and the provided message', () => {
    const err = new ServiceUnavailableError('Webhook secret is unavailable');
    expect(err.statusCode).toBe(503);
    expect(err.message).toBe('Webhook secret is unavailable');
  });

  it('is an operational AppError', () => {
    const err = new ServiceUnavailableError('x');
    expect(err).toBeInstanceOf(AppError);
    expect(err.isOperational).toBe(true);
  });
});

describe('parseDateParam', () => {
  it('returns a Date for a valid ISO string', () => {
    const result = parseDateParam('2024-01-15T10:30:00Z');
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe('2024-01-15T10:30:00.000Z');
  });

  it('throws BadRequestError for an invalid date string', () => {
    expect(() => parseDateParam('not-a-date')).toThrow('Invalid date parameter');
  });

  it('includes the param name in the error message', () => {
    expect(() => parseDateParam('invalid', 'startDate')).toThrow('Invalid startDate parameter');
  });

  it('uses "date" as the default param name', () => {
    expect(() => parseDateParam('invalid')).toThrow('Invalid date parameter');
  });
});

describe('every subclass is an instance of ITSELF, not only of AppError', () => {
  // The base constructor pinned the prototype to AppError.prototype, so
  // `err instanceof ForbiddenError` was false for a ForbiddenError: the two
  // catch blocks that asked (the auth middleware, the token refresh) always
  // fell through to their generic answer.
  it('instanceof matches the class that was constructed, its base and Error', () => {
    const cases: Array<[AppError, abstract new (...args: never[]) => AppError]> = [
      [new BadRequestError('x'), BadRequestError],
      [new UnauthorizedError(), UnauthorizedError],
      [new ForbiddenError(), ForbiddenError],
      [new NotFoundError('Server'), NotFoundError],
      [new ConflictError('x'), ConflictError],
      [new UnsupportedMediaTypeError('x'), UnsupportedMediaTypeError],
      [new ServiceUnavailableError('x'), ServiceUnavailableError],
    ];
    for (const [err, cls] of cases) {
      expect(err).toBeInstanceOf(cls);
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(Object.getPrototypeOf(err)).toBe(cls.prototype);
    }
  });

  it('a sibling class never matches', () => {
    expect(new ForbiddenError()).not.toBeInstanceOf(UnauthorizedError);
    expect(new UnauthorizedError()).not.toBeInstanceOf(ForbiddenError);
    expect(new AppError('x', 418)).not.toBeInstanceOf(ForbiddenError);
  });
});

describe('violatesUniqueIndex', () => {
  /** A P2002 as Prisma 7 raises it behind the pg adapter: the index named in `meta`. */
  const adapterViolation = (index: string) => Object.assign(new Error(`Unique constraint failed on the constraint: \`${index}\``), {
    code: 'P2002',
    meta: { modelName: 'Role', driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { index } } } },
  });

  it('a name matches that index exactly, as the adapter names it', () => {
    expect(violatesUniqueIndex(adapterViolation('roles_server_id_name_key'), 'roles_server_id_name_key')).toBe(true);
    expect(violatesUniqueIndex(adapterViolation('roles_pkey'), 'roles_server_id_name_key')).toBe(false);
    // never a part of a name
    expect(violatesUniqueIndex(adapterViolation('roles_server_id_name_key_2'), 'roles_server_id_name_key')).toBe(false);
    expect(violatesUniqueIndex(adapterViolation('roles_server_id_name_key'), 'roles_server_id')).toBe(false);
  });

  it('a predicate decides on each name given', () => {
    const pending = (name: string) => name.startsWith('reports_pending_');
    expect(violatesUniqueIndex(adapterViolation('reports_pending_user_key'), pending)).toBe(true);
    expect(violatesUniqueIndex(adapterViolation('reports_pkey'), pending)).toBe(false);
  });

  it('the index named as a string meta.target (the form without the adapter) counts; a list of fields does not', () => {
    expect(violatesUniqueIndex(Object.assign(new Error('x'), { code: 'P2002', meta: { target: 'roles_server_id_name_key' } }), 'roles_server_id_name_key')).toBe(true);
    expect(violatesUniqueIndex(Object.assign(new Error('x'), { code: 'P2002', meta: { target: ['serverId', 'name'] } }), 'roles_server_id_name_key')).toBe(false);
  });

  it('the message alone, another code, or no error at all is never a match', () => {
    expect(violatesUniqueIndex(Object.assign(new Error('Unique constraint failed on the constraint: `roles_server_id_name_key`'), { code: 'P2002' }), 'roles_server_id_name_key')).toBe(false);
    expect(violatesUniqueIndex(Object.assign(adapterViolation('roles_server_id_name_key'), { code: 'P2003' }), 'roles_server_id_name_key')).toBe(false);
    expect(violatesUniqueIndex(null, 'roles_server_id_name_key')).toBe(false);
    expect(violatesUniqueIndex(undefined, () => true)).toBe(false);
    expect(violatesUniqueIndex('P2002', () => true)).toBe(false);
  });
});
