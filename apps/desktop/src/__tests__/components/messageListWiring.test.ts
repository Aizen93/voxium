// @vitest-environment node
// A source scan, like mainLayoutWebhookWiring.test.ts: MessageList renders
// through react-virtuoso, which jsdom cannot lay out, so no component test
// mounts it. What it decides per row is pinned on the source.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LIST = fileURLToPath(new URL('../../components/chat/MessageList.tsx', import.meta.url));
const source = readFileSync(LIST, 'utf8');

/** The body of `const shouldShowHeader = ...;`. */
function shouldShowHeader(): string {
  const start = source.indexOf('const shouldShowHeader');
  expect(start, 'shouldShowHeader not found in MessageList').toBeGreaterThan(-1);
  const end = source.indexOf(';', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('MessageList groups rows through utils/messageGrouping', () => {
  it('imports startsMessageGroup from utils/messageGrouping', () => {
    expect(source).toMatch(/import \{[^}]*\bstartsMessageGroup\b[^}]*\} from '\.\.\/\.\.\/utils\/messageGrouping';/);
  });

  it('shouldShowHeader is the first row OR startsMessageGroup(messages[index - 1], messages[index])', () => {
    const body = shouldShowHeader();
    expect(body).toMatch(/index === 0 \|\|\s*startsMessageGroup\(\s*messages\[index - 1\]\s*,\s*messages\[index\]\s*\)/);
    // no inline author-id comparison left beside it (the webhook-name rule lives in the helper)
    expect(body).not.toMatch(/author\.id/);
  });

  it('every header decision goes through shouldShowHeader', () => {
    expect(source).toMatch(/const showHeader = shouldShowHeader\(dataIndex\);/);
    expect(source).toMatch(/showHeader=\{showHeader\}/);
  });
});
