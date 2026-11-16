import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Request, Response } from 'express';
import { requireSingleValueQuery, SINGLE_VALUE_QUERY_MESSAGE } from '../../middleware/singleValueQuery';
import { errorHandler } from '../../middleware/errorHandler';
import { BadRequestError } from '../../utils/errors';

/** The rule on a stub request whose query is exactly `query`. */
function judge(query: Record<string, unknown>): unknown {
  const next = vi.fn();
  requireSingleValueQuery({ query } as unknown as Request, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  return next.mock.calls[0][0];
}

describe('requireSingleValueQuery', () => {
  it('passes a request with no query, with string values, and with an empty value', () => {
    expect(judge({})).toBeUndefined();
    expect(judge({ q: 'hello', limit: '20' })).toBeUndefined();
    expect(judge({ inline: '' })).toBeUndefined();
  });

  it('refuses a repeated parameter (the simple parser\'s array) with a 400', () => {
    const err = judge({ q: 'ok', around: ['a', 'b'] });
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).statusCode).toBe(400);
    expect((err as BadRequestError).message).toBe(SINGLE_VALUE_QUERY_MESSAGE);
  });

  it('refuses a nested object (the extended parser\'s shape), so a parser change cannot reopen it', () => {
    expect(judge({ search: { $ne: 'x' } })).toBeInstanceOf(BadRequestError);
  });

  it('reads own keys only, on a null-prototype object like the one querystring builds', () => {
    const query = Object.assign(Object.create(null) as Record<string, unknown>, { constructor: 'a', toString: 'b' });
    expect(judge(query)).toBeUndefined();
  });

  it('answers through the error handler with the shape every 400 has', async () => {
    const app = express();
    app.use(requireSingleValueQuery);
    app.get('/x', (_req, res) => { res.json({ success: true }); });
    app.use(errorHandler);

    const refused = await request(app).get('/x?limit=1&limit=2');
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ success: false, error: SINGLE_VALUE_QUERY_MESSAGE });

    const passed = await request(app).get('/x?limit=1');
    expect(passed.status).toBe(200);
  });
});
