// @vitest-environment node
// Pure filesystem check — no DOM, and jsdom does not give this module a
// file:// import.meta.url to resolve the source directory against.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Where the message search lives: as a field in each chat header (the space's
 * and the conversation's), because it is scoped to that context; the sidebar
 * column heads with the brand mark instead; Ctrl/⌘K keeps the global path.
 */

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

describe('where the search sits', () => {
  it('the space and the DM headers carry the field, not a loop icon', () => {
    for (const rel of ['components/chat/ChatArea.tsx', 'components/dm/DMChatArea.tsx']) {
      const text = src(rel);
      expect(text, rel).toContain('<SearchField');
      expect(text, rel).not.toMatch(/<Search\s+size=/);
    }
  });

  it('the sidebar column shows the brand mark and no search box; the shortcut path stays', () => {
    const text = src('components/layout/MainLayout.tsx');
    expect(text).not.toContain("t('search.placeholder')");
    expect(text).toContain('data-testid="sidebar-brand"');
    expect(text).toContain('/logo.svg');
    expect(text).toContain('setShowGlobalSearch((prev) => !prev)'); // Ctrl/⌘K
    expect(text).toContain('<SearchModal');
  });

  it('one Mac detection serves the field and the strip', () => {
    expect(src('components/search/SearchField.tsx')).toContain("from '../../utils/platform'");
    expect(src('components/server/SpacesStrip.tsx')).toContain("from '../../utils/platform'");
    expect(src('components/server/SpacesStrip.tsx')).not.toContain("includes('MAC')");
  });
});
