import { describe, it, expect } from 'vitest';
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  parseDateParam,
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
