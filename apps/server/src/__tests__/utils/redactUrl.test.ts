import { describe, it, expect } from 'vitest';
import { redactUrl, redactedPath } from '../../utils/redactUrl';

describe('redactUrl', () => {
  it('redacts invite codes', () => {
    expect(redactUrl('/api/v1/invites/SUPERSECRET')).toBe('/api/v1/invites/[redacted]');
    expect(redactUrl('/api/v1/invites/SUPERSECRET/join')).toBe('/api/v1/invites/[redacted]/join');
    expect(redactUrl('/api/v1/invites/SUPERSECRET?x=1')).toBe('/api/v1/invites/[redacted]?x=1');
  });

  it('redacts everything after the id of the public webhook execute URL, keeping the id', () => {
    expect(redactUrl('/api/v1/webhooks/wh_abc/SECRETTOKEN')).toBe('/api/v1/webhooks/wh_abc/[redacted]');
    expect(redactUrl('/api/v1/webhooks/wh_abc/SECRETTOKEN?wait=true')).toBe('/api/v1/webhooks/wh_abc/[redacted]?wait=true');
    // a trailing path goes too: the token is what matters, and over-redacting costs nothing
    expect(redactUrl('/api/v1/webhooks/wh_abc/SECRETTOKEN/extra')).toBe('/api/v1/webhooks/wh_abc/[redacted]');
  });

  it('redacts a mis-composed sender URL too: an empty id, a dot segment, a longer path (a 404, but logged)', () => {
    expect(redactUrl('/api/v1/webhooks//SECRETTOKEN')).toBe('/api/v1/webhooks//[redacted]');
    expect(redactUrl('/api/v1/webhooks/wh_abc/./SECRETTOKEN')).toBe('/api/v1/webhooks/wh_abc/[redacted]');
    expect(redactUrl('/api/v1/webhooks/wh_abc/SECRETTOKEN/more/SECRET2?x=1')).toBe('/api/v1/webhooks/wh_abc/[redacted]?x=1');
    expect(redactedPath('/api/v1/webhooks//SECRETTOKEN?wait=true')).toBe('/api/v1/webhooks//[redacted]');
  });

  it('redacts upper- and mixed-case variants (Express routes case-insensitively)', () => {
    expect(redactUrl('/API/V1/WEBHOOKS/wh_abc/SECRETTOKEN')).toBe('/API/V1/WEBHOOKS/wh_abc/[redacted]');
    expect(redactUrl('/Api/v1/Webhooks/wh_abc/SECRETTOKEN?wait=true')).toBe('/Api/v1/Webhooks/wh_abc/[redacted]?wait=true');
    expect(redactUrl('/api/V1/webHooks/wh_abc/SECRETTOKEN/extra')).toBe('/api/V1/webHooks/wh_abc/[redacted]');
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

describe('redactUrl — a `token` query value never reaches a log line (#167)', () => {
  it('redacts the value on any path, keeping the other parameters', () => {
    expect(redactUrl('/api/v1/uploads/attachments/a.png?token=eyJhbGciOi.payload.sig')).toBe('/api/v1/uploads/attachments/a.png?token=[redacted]');
    expect(redactUrl('/api/v1/channels/c1/messages?before=2026-01-01&token=JWT&limit=50')).toBe('/api/v1/channels/c1/messages?before=2026-01-01&token=[redacted]&limit=50');
    expect(redactUrl('/health?token=JWT')).toBe('/health?token=[redacted]');
  });

  it('redacts every occurrence, whatever the case of the key', () => {
    expect(redactUrl('/x?token=A&Token=B&TOKEN=C')).toBe('/x?token=[redacted]&Token=[redacted]&TOKEN=[redacted]');
  });

  it('redacts an empty value, and a value up to the next parameter', () => {
    expect(redactUrl('/x?token=&a=1')).toBe('/x?token=[redacted]&a=1');
  });

  it('reads everything after the first ? as the query: a # never ends it (a client sends no fragment, so a # in the line is text)', () => {
    expect(redactUrl('/x?a=1#&token=JWT')).toBe('/x?a=1#&token=[redacted]');
    expect(redactUrl('/x?a=1#token=JWT')).toBe('/x?a=1#token=[redacted]');
    expect(redactUrl('/x?a=1##token=JWT#b=2&c=3')).toBe('/x?a=1##token=[redacted]&c=3');
    // a credential's value runs to the next &: a # inside it hides the rest too
    expect(redactUrl('/x?token=JWT#frag')).toBe('/x?token=[redacted]');
    expect(redactUrl('/x?token=abc#def&x=1')).toBe('/x?token=[redacted]&x=1');
    expect(redactUrl('/x?a=1#b&TOKEN=JWT&c=2')).toBe('/x?a=1#b&TOKEN=[redacted]&c=2');
  });

  it('is idempotent (the JSON access log applies it twice)', () => {
    const once = redactUrl('/api/v1/invites/CODE?token=JWT&x=1');
    expect(redactUrl(once)).toBe(once);
    expect(once).toBe('/api/v1/invites/[redacted]?token=[redacted]&x=1');
  });

  it('leaves parameters that merely contain "token" in their name alone, and a "token" in the path', () => {
    expect(redactUrl('/x?mytoken=1&token_type=2&tokens=3')).toBe('/x?mytoken=1&token_type=2&tokens=3');
    expect(redactUrl('/api/v1/auth/mail-block/token?a=1')).toBe('/api/v1/auth/mail-block/token?a=1');
  });

  it('redacts the value in an absolute-form request target too', () => {
    expect(redactUrl('http://voxium.test/api/v1/x?token=JWT')).toBe('http://voxium.test/api/v1/x?token=[redacted]');
  });

  it('redacts a percent-encoded key spelling as well', () => {
    expect(redactUrl('/x?%74oken=JWT')).toBe('/x?%74oken=[redacted]');
  });
});

describe('redactedPath', () => {
  it('drops the query string (it may carry ?token=) and redacts the path', () => {
    expect(redactedPath('/api/v1/uploads/attachments/a.png?token=JWT')).toBe('/api/v1/uploads/attachments/a.png');
    expect(redactedPath('/api/v1/webhooks/wh_abc/SECRETTOKEN?wait=true')).toBe('/api/v1/webhooks/wh_abc/[redacted]');
  });
});
