import { describe, it, expect } from 'vitest';
import { redactUrl, redactedPath } from '../../utils/redactUrl';

describe('redactUrl', () => {
  it('redacts invite codes', () => {
    expect(redactUrl('/api/v1/invites/SUPERSECRET')).toBe('/api/v1/invites/[redacted]');
    expect(redactUrl('/api/v1/invites/SUPERSECRET/join')).toBe('/api/v1/invites/[redacted]/join');
    expect(redactUrl('/api/v1/invites/SUPERSECRET?x=1')).toBe('/api/v1/invites/[redacted]?x=1');
  });

  it('redacts the token segment of the public webhook execute URL, keeping the id', () => {
    expect(redactUrl('/api/v1/webhooks/wh_abc/SECRETTOKEN')).toBe('/api/v1/webhooks/wh_abc/[redacted]');
    expect(redactUrl('/api/v1/webhooks/wh_abc/SECRETTOKEN?wait=true')).toBe('/api/v1/webhooks/wh_abc/[redacted]?wait=true');
    expect(redactUrl('/api/v1/webhooks/wh_abc/SECRETTOKEN/extra')).toBe('/api/v1/webhooks/wh_abc/[redacted]/extra');
  });

  it('redacts upper- and mixed-case variants (Express routes case-insensitively)', () => {
    expect(redactUrl('/API/V1/WEBHOOKS/wh_abc/SECRETTOKEN')).toBe('/API/V1/WEBHOOKS/wh_abc/[redacted]');
    expect(redactUrl('/Api/v1/Webhooks/wh_abc/SECRETTOKEN?wait=true')).toBe('/Api/v1/Webhooks/wh_abc/[redacted]?wait=true');
    expect(redactUrl('/api/V1/webHooks/wh_abc/SECRETTOKEN/extra')).toBe('/api/V1/webHooks/wh_abc/[redacted]/extra');
    expect(redactUrl('/API/V1/INVITES/SUPERSECRET')).toBe('/API/V1/INVITES/[redacted]');
    expect(redactUrl('/api/v1/Invites/SUPERSECRET/join')).toBe('/api/v1/Invites/[redacted]/join');
    expect(redactedPath('/API/v1/Webhooks/wh_abc/SECRETTOKEN?token=Q')).toBe('/API/v1/Webhooks/wh_abc/[redacted]');
  });

  it('leaves the management routes untouched (they never contain /api/v1/webhooks/)', () => {
    expect(redactUrl('/api/v1/servers/s1/webhooks/wh_abc/rotate')).toBe('/api/v1/servers/s1/webhooks/wh_abc/rotate');
    expect(redactUrl('/api/v1/servers/s1/webhooks')).toBe('/api/v1/servers/s1/webhooks');
    expect(redactUrl('/API/V1/Servers/s1/Webhooks/wh_abc/rotate')).toBe('/API/V1/Servers/s1/Webhooks/wh_abc/rotate');
    expect(redactUrl('http://voxium.test/api/v1/servers/s1/webhooks/wh_abc/rotate'))
      .toBe('http://voxium.test/api/v1/servers/s1/webhooks/wh_abc/rotate');
  });

  it('redacts an absolute-form request target (Express routes it, and its originalUrl is the whole URL)', () => {
    expect(redactUrl('http://voxium.test/api/v1/webhooks/wh_abc/SECRETTOKEN')).toBe('http://voxium.test/api/v1/webhooks/wh_abc/[redacted]');
    expect(redactUrl('https://voxium.test:8443/api/v1/webhooks/wh_abc/SECRETTOKEN?wait=true'))
      .toBe('https://voxium.test:8443/api/v1/webhooks/wh_abc/[redacted]?wait=true');
    expect(redactUrl('HTTP://VOXIUM.TEST/API/V1/WEBHOOKS/wh_abc/SECRETTOKEN')).toBe('HTTP://VOXIUM.TEST/API/V1/WEBHOOKS/wh_abc/[redacted]');
    expect(redactedPath('http://voxium.test/api/v1/webhooks/wh_abc/SECRETTOKEN?wait=true')).toBe('http://voxium.test/api/v1/webhooks/wh_abc/[redacted]');
  });

  it('redacts double-slash variants (a base URL with a trailing slash composes them; logged even when not executed)', () => {
    expect(redactUrl('//api/v1/webhooks/wh_abc/SECRETTOKEN')).toBe('//api/v1/webhooks/wh_abc/[redacted]');
    expect(redactUrl('/api/v1//webhooks/wh_abc/SECRETTOKEN')).toBe('/api/v1//webhooks/wh_abc/[redacted]');
    expect(redactUrl('/api//v1/webhooks/wh_abc/SECRETTOKEN')).toBe('/api//v1/webhooks/wh_abc/[redacted]');
    expect(redactUrl('/api/v1/webhooks//wh_abc/SECRETTOKEN')).toBe('/api/v1/webhooks//wh_abc/[redacted]');
    expect(redactUrl('/api/v1/webhooks/wh_abc//SECRETTOKEN')).toBe('/api/v1/webhooks/wh_abc//[redacted]');
  });

  it('a look-alike path under another prefix is redacted too (unanchored on purpose: over-redacting costs nothing)', () => {
    expect(redactUrl('/x/api/v1/webhooks/wh_abc/NOT_THE_ROUTE')).toBe('/x/api/v1/webhooks/wh_abc/[redacted]');
  });

  it('leaves a webhook URL with no token segment alone', () => {
    expect(redactUrl('/api/v1/webhooks/wh_abc')).toBe('/api/v1/webhooks/wh_abc');
  });

  it('leaves other URLs and undefined alone', () => {
    expect(redactUrl('/health')).toBe('/health');
    expect(redactUrl(undefined)).toBeUndefined();
  });
});

describe('redactedPath', () => {
  it('drops the query string (it may carry ?token=) and redacts the path', () => {
    expect(redactedPath('/api/v1/uploads/attachments/a.png?token=JWT')).toBe('/api/v1/uploads/attachments/a.png');
    expect(redactedPath('/api/v1/webhooks/wh_abc/SECRETTOKEN?wait=true')).toBe('/api/v1/webhooks/wh_abc/[redacted]');
  });
});
