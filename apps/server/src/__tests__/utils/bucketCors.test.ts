import { describe, it, expect } from 'vitest';
import type { CORSRule } from '@aws-sdk/client-s3';
import {
  CORS_PROBE_KEY,
  UPLOAD_CORS_RULE_ID,
  buildUploadCorsRule,
  checkableOrigins,
  describeCorsRule,
  planUploadCorsWrite,
  preflightAccepts,
} from '../../utils/bucketCors';

const WEB = 'https://chat.example.org';

const answer = (headers: Record<string, string>) => (name: string) => headers[name.toLowerCase()] ?? null;
const GOOD = {
  'access-control-allow-origin': WEB,
  'access-control-allow-methods': 'PUT, GET',
  'access-control-allow-headers': 'content-type',
};

describe('utils/bucketCors — the probe key', () => {
  it('is a dedicated key outside every key shape the server stores', () => {
    expect(CORS_PROBE_KEY).toBe('cors-check/probe');
    expect(CORS_PROBE_KEY).not.toMatch(/^(avatars|server-icons|attachments)\//);
  });
});

describe('utils/bucketCors — checkableOrigins', () => {
  it('keeps bare origins once each, sorted, tauri schemes and ports included', () => {
    expect(checkableOrigins([
      WEB, 'tauri://localhost', 'https://tauri.localhost', 'http://tauri.localhost', 'http://localhost:8080', WEB, ' http://localhost:8080 ',
    ])).toEqual({
      origins: ['http://localhost:8080', 'http://tauri.localhost', 'https://chat.example.org', 'https://tauri.localhost', 'tauri://localhost'],
      dropped: 0,
    });
  });

  it('drops entries with a wildcard, counting them', () => {
    expect(checkableOrigins([WEB, 'https://*.example.org', 'http://localhost:*', '*'])).toEqual({ origins: [WEB], dropped: 3 });
  });

  it('drops what is not exactly the origin a browser sends, counting each', () => {
    const notOrigins = [
      'https://chat.example.org/', // trailing slash
      'https://chat.example.org/app', // path
      'https://chat.example.org?x=1', // query
      'https://user:pw@chat.example.org', // credentials
      'HTTPS://Chat.Example.org', // not the serialised spelling
      'https://chat.example.org:443', // default port written out
      'chat.example.org', // no scheme
      'not a url',
      'null',
      'tauri://localhost/',
      'file:///tmp/x',
    ];
    expect(checkableOrigins([WEB, ...notOrigins])).toEqual({ origins: [WEB], dropped: notOrigins.length });
  });

  it('ignores blank entries without counting them (a trailing comma)', () => {
    expect(checkableOrigins([WEB, '', '  '])).toEqual({ origins: [WEB], dropped: 0 });
  });

  it('answers nothing to check for an empty list', () => {
    expect(checkableOrigins([])).toEqual({ origins: [], dropped: 0 });
  });
});

describe('utils/bucketCors — preflightAccepts', () => {
  it('accepts the store echoing the origin, allowing PUT and content-type', () => {
    expect(preflightAccepts(200, answer(GOOD), WEB)).toBe(true);
    expect(preflightAccepts(204, answer(GOOD), WEB)).toBe(true);
  });

  it('refuses a status outside 2xx', () => {
    for (const status of [199, 301, 400, 403, 404, 500]) expect(preflightAccepts(status, answer(GOOD), WEB)).toBe(false);
  });

  it('requires the allow-origin to be the origin or *', () => {
    expect(preflightAccepts(200, answer({ ...GOOD, 'access-control-allow-origin': '*' }), WEB)).toBe(true);
    expect(preflightAccepts(200, answer({ ...GOOD, 'access-control-allow-origin': 'https://other.example.org' }), WEB)).toBe(false);
    expect(preflightAccepts(200, answer({ ...GOOD, 'access-control-allow-origin': 'null' }), WEB)).toBe(false);
    const withoutOrigin: Record<string, string> = { ...GOOD };
    delete withoutOrigin['access-control-allow-origin'];
    expect(preflightAccepts(200, answer(withoutOrigin), WEB)).toBe(false);
  });

  it('requires PUT among the allowed methods, or *, compared exactly, with any spacing', () => {
    const methods = (value?: string) => {
      const headers: Record<string, string> = { ...GOOD };
      if (value === undefined) delete headers['access-control-allow-methods'];
      else headers['access-control-allow-methods'] = value;
      return preflightAccepts(200, answer(headers), WEB);
    };
    expect(methods('GET, HEAD')).toBe(false);
    expect(methods('GET,HEAD,POST')).toBe(false);
    expect(methods(undefined)).toBe(false);
    expect(methods('')).toBe(false);
    // A browser compares the method exactly: a store answering `put` is refused
    expect(methods('put')).toBe(false);
    expect(methods('GET ,  PuT ')).toBe(false);
    expect(methods('GET ,  PUT ')).toBe(true);
    expect(methods('PUT, GET')).toBe(true);
    expect(methods('*')).toBe(true);
    expect(methods('GET, *')).toBe(true);
  });

  it('requires content-type among the allowed headers, or *, with any case and spacing', () => {
    const allowed = (value?: string) => {
      const headers: Record<string, string> = { ...GOOD };
      if (value === undefined) delete headers['access-control-allow-headers'];
      else headers['access-control-allow-headers'] = value;
      return preflightAccepts(200, answer(headers), WEB);
    };
    expect(allowed('x-amz-meta-foo')).toBe(false);
    expect(allowed('content-*')).toBe(false);
    expect(allowed(undefined)).toBe(false);
    expect(allowed('')).toBe(false);
    expect(allowed('Content-Type')).toBe(true);
    expect(allowed('x-other ,  CONTENT-TYPE  ')).toBe(true);
    expect(allowed('*')).toBe(true);
  });

  it('asks nothing about GET', () => {
    expect(preflightAccepts(200, answer({ ...GOOD, 'access-control-allow-methods': 'PUT' }), WEB)).toBe(true);
  });
});

describe('utils/bucketCors — the rule that is written', () => {
  it('names exactly the origins given, PUT and GET, content-type', () => {
    expect(buildUploadCorsRule(['https://b.example.org', WEB, WEB])).toEqual({
      ID: UPLOAD_CORS_RULE_ID,
      AllowedOrigins: ['https://b.example.org', WEB],
      AllowedMethods: ['GET', 'PUT'],
      AllowedHeaders: ['content-type'],
      MaxAgeSeconds: 3600,
    });
  });

  const operatorRules: CORSRule[] = [
    { ID: 'site', AllowedOrigins: ['https://www.example.org'], AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 60 },
    { AllowedOrigins: ['*'], AllowedMethods: ['GET'] },
  ];

  it('appends the rule last and writes every other rule back unchanged and in order', () => {
    const plan = planUploadCorsWrite(operatorRules, [WEB]);
    expect(plan.previous).toBeNull();
    expect(plan.kept).toBe(2);
    expect(plan.rules).toEqual([...operatorRules, buildUploadCorsRule([WEB])]);
    expect(plan.rules[0]).toBe(operatorRules[0]);
    expect(plan.rules[1]).toBe(operatorRules[1]);
  });

  it('replaces the rule named voxium-uploads at the position it already has', () => {
    const old: CORSRule = { ID: UPLOAD_CORS_RULE_ID, AllowedOrigins: ['https://gone.example.org'], AllowedMethods: ['PUT'] };
    const existing = [operatorRules[0], old, operatorRules[1]];
    const plan = planUploadCorsWrite(existing, [WEB]);
    expect(plan.previous).toBe(old);
    expect(plan.kept).toBe(2);
    expect(plan.rules).toEqual([operatorRules[0], buildUploadCorsRule([WEB]), operatorRules[1]]);
  });

  it('two rules named voxium-uploads: the first is replaced in place, the second is written back unchanged and counted as kept', () => {
    const first: CORSRule = { ID: UPLOAD_CORS_RULE_ID, AllowedOrigins: ['https://gone.example.org'], AllowedMethods: ['PUT'] };
    const second: CORSRule = { ID: UPLOAD_CORS_RULE_ID, AllowedOrigins: ['https://other.example.org'], AllowedMethods: ['GET'] };
    const plan = planUploadCorsWrite([operatorRules[0], first, second, operatorRules[1]], [WEB]);
    expect(plan.previous).toBe(first);
    expect(plan.kept).toBe(3);
    expect(plan.rules).toEqual([operatorRules[0], buildUploadCorsRule([WEB]), second, operatorRules[1]]);
    expect(plan.rules[2]).toBe(second);
  });

  it('a bucket with no rules gets the upload rule alone', () => {
    expect(planUploadCorsWrite([], [WEB]).rules).toEqual([buildUploadCorsRule([WEB])]);
  });

  it('is the same configuration whatever the order the origins come in', () => {
    expect(planUploadCorsWrite(operatorRules, ['https://b.example.org', WEB])).toEqual(planUploadCorsWrite(operatorRules, [WEB, 'https://b.example.org']));
  });

  it('states its true limits in the module: only its own rule changes, and the write has no precondition', async () => {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(new URL('../../utils/bucketCors.ts', import.meta.url), 'utf8');
    // Comment line breaks (" *" at the start of a line) read as one space
    const source = raw.replace(/\s*\n\s*\*\s*/g, ' ');
    expect(source).toContain('changes only the rule named `voxium-uploads`');
    expect(source).toContain('PutBucketCors has no precondition');
    expect(source).not.toMatch(/never narrows/i);
  });
});

describe('utils/bucketCors — describeCorsRule', () => {
  it('shows the shape of a rule without its origins', () => {
    const line = describeCorsRule({ AllowedOrigins: ['https://secret.example.org', 'b'], AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'], MaxAgeSeconds: 3600 });
    expect(line).toBe('methods PUT; 2 origins; headers content-type; exposed none; max-age 3600');
    expect(line).not.toContain('secret.example.org');
  });
});

describe('utils/bucketCors — the wiring (read from the sources)', () => {
  const read = async (relative: string) => {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL(relative, import.meta.url), 'utf8');
  };

  it('the boot does not wait for the check', async () => {
    const source = await read('../../index.ts');
    expect(source).toContain('void ensureBucketCors(parseCorsOrigins(process.env.CORS_ORIGIN));');
    expect(source).not.toMatch(/await\s+ensureBucketCors/);
  });

  it('the HTTP layer and the socket server read CORS_ORIGIN through the one parser', async () => {
    expect(await read('../../app.ts')).toContain('parseCorsOrigins(process.env.CORS_ORIGIN)');
    const socketServer = await read('../../websocket/socketServer.ts');
    expect(socketServer).toContain('parseCorsOrigins(process.env.CORS_ORIGIN)');
    expect(socketServer).not.toMatch(/process\.env\.CORS_ORIGIN\s*\|\|/);
  });

  it('the dev script uses the shared code, keeps its dev- refusal and lists no LAN address', async () => {
    const script = await read('../../../../../scripts/setup-dev-bucket.ts');
    expect(script).toContain('reconcileBucketCors');
    expect(script).toContain("bucket.startsWith('dev-')");
    expect(script).toContain("'http://tauri.localhost'");
    expect(script).not.toMatch(/192\.168\./);
  });
});
