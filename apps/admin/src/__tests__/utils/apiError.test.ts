import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders, type InternalAxiosRequestConfig } from 'axios';
import { logMessage } from '../../utils/apiError';

/**
 * logMessage is what every admin console.error prints for a failed request.
 * An axios error carries its request config, the admin's token included in
 * its headers: only a sentence may come out, whatever shape was thrown.
 */

const config: InternalAxiosRequestConfig = { headers: new AxiosHeaders({ Authorization: 'Bearer SECRET' }) };

function expectNoToken(text: string) {
  expect(typeof text).toBe('string');
  expect(text).not.toContain('Bearer');
  expect(text).not.toContain('SECRET');
}

describe('logMessage', () => {
  it("gives the server's own sentence for a refusal that carries one", () => {
    const err = new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE', config, undefined, {
      status: 500, statusText: '', headers: {}, config, data: { success: false, error: 'Internal server error' },
    });
    const text = logMessage(err);
    expect(text).toBe('Internal server error');
    expectNoToken(text);
  });

  it("gives the error's own message when no response came back", () => {
    const text = logMessage(new AxiosError('Network Error', 'ERR_NETWORK', config));
    expect(text).toBe('Network Error');
    expectNoToken(text);
  });

  it('gives plain text, never the object, for a thrown value that is not an Error', () => {
    const text = logMessage({ config, response: { status: 500, config } });
    expect(text).toBe('[object Object]');
    expectNoToken(text);
  });
});
