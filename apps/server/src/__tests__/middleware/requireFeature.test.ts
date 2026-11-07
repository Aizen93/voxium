import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const flags: Record<string, boolean> = {};
vi.mock('../../utils/featureFlags', () => ({
  isFeatureEnabled: (name: string) => flags[name] ?? true,
}));

import { requireFeature } from '../../middleware/requireFeature';
// AppError's constructor resets the prototype to AppError.prototype, so a
// ForbiddenError is recognised by `instanceof AppError` + its 403 status
import { AppError } from '../../utils/errors';

const req = {} as Request;
const res = {} as Response;

describe('requireFeature', () => {
  beforeEach(() => {
    for (const k of Object.keys(flags)) delete flags[k];
  });

  it('calls next() with no error while the flag is enabled', () => {
    flags.webhooks = true;
    const next = vi.fn();
    requireFeature('webhooks', 'Incoming webhooks are currently disabled')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
  });

  it('passes a ForbiddenError (403) carrying the exact message while the flag is off', () => {
    flags.webhooks = false;
    const next = vi.fn();
    requireFeature('webhooks', 'Incoming webhooks are currently disabled')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(403);
    expect(err.message).toBe('Incoming webhooks are currently disabled');
  });

  it('reads the flag per request, so a toggle takes effect without rebuilding the middleware', () => {
    const mw = requireFeature('server_discovery', 'Server discovery is currently disabled');
    const next = vi.fn();
    flags.server_discovery = false;
    mw(req, res, next);
    flags.server_discovery = true;
    mw(req, res, next);
    expect(next.mock.calls[0][0]).toBeInstanceOf(AppError);
    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(next.mock.calls[1]).toEqual([]);
  });

  it('checks the flag it was built for, not another one', () => {
    flags.webhooks = false;
    const next = vi.fn();
    requireFeature('server_discovery', 'Server discovery is currently disabled')(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });
});
