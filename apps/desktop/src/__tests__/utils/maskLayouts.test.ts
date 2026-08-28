import { describe, it, expect, beforeEach } from 'vitest';
import type { MaskRect } from '../../stores/annotationStore';
import {
  sourceKeyFromSettings, loadMaskLayouts, saveMaskLayouts, upsertMaskLayout, findMaskLayout,
  maskLayoutStorageKey, MASK_LAYOUTS_MAX, MASK_LAYOUT_SRC_MAX,
} from '../../utils/maskLayouts';

const mask = (id: string, overrides: Partial<MaskRect> = {}): MaskRect => ({ id, x: 0.1, y: 0.1, w: 0.3, h: 0.2, ...overrides });

beforeEach(() => {
  localStorage.clear();
});

describe('maskLayouts', () => {
  it('derives the source key from surface kind and size, and refuses a sizeless source', () => {
    expect(sourceKeyFromSettings({ displaySurface: 'window', width: 1280, height: 720 })).toBe('window:1280x720');
    expect(sourceKeyFromSettings({ width: 1920.4, height: 1079.6 })).toBe('unknown:1920x1080');
    expect(sourceKeyFromSettings({ displaySurface: 'monitor' })).toBeNull();
    expect(sourceKeyFromSettings({ displaySurface: 'monitor', width: 0, height: 720 })).toBeNull();
  });

  it('round-trips entries per user — another account reads a different key', () => {
    saveMaskLayouts('alice', upsertMaskLayout([], 'window:1280x720', [mask('m1', { style: 'pixelate' })], 111));
    expect(loadMaskLayouts('alice')).toEqual([
      // The style is deliberately NOT stored — cosmetic covers must be
      // re-chosen per session ("Cover every session")
      { key: 'window:1280x720', masks: [{ id: 'm1', x: 0.1, y: 0.1, w: 0.3, h: 0.2 }], lastUsed: 111 },
    ]);
    expect(loadMaskLayouts('bob')).toEqual([]);
    expect(localStorage.getItem(maskLayoutStorageKey('alice'))).not.toBeNull();
  });

  it('sanitizes on load: bad geometry drops the mask, EVERY style is dropped, oversized covers drop the src', () => {
    localStorage.setItem(maskLayoutStorageKey('u'), JSON.stringify([
      {
        key: 'window:1x1',
        lastUsed: 5,
        masks: [
          mask('ok'),
          mask('styled', { style: 'blur' }),
          { id: 'bad-geom', x: 7, y: 0.1, w: 0.2, h: 0.2 },
          { id: 'nan', x: NaN, y: 0.1, w: 0.2, h: 0.2 },
          { ...mask('bad-style'), style: 'glitter' },
          { ...mask('big-src'), src: `data:image/webp;base64,${'A'.repeat(MASK_LAYOUT_SRC_MAX + 1)}` },
          { ...mask('good-src'), src: 'data:image/webp;base64,AAAA' },
          { ...mask('evil-src'), src: 'javascript:alert(1)' },
          'not a mask',
        ],
      },
      { key: 'no-masks', lastUsed: 1, masks: [] },
      { key: 'x'.repeat(200), lastUsed: 1, masks: [mask('m')] },
      'junk',
    ]));
    const [entry, ...rest] = loadMaskLayouts('u');
    expect(rest).toEqual([]);
    expect(entry.masks.map((m) => m.id)).toEqual(['ok', 'styled', 'bad-style', 'big-src', 'good-src', 'evil-src']);
    expect(entry.masks.find((m) => m.id === 'styled')!.style).toBeUndefined(); // never remembered
    expect(entry.masks.find((m) => m.id === 'bad-style')!.style).toBeUndefined();
    expect(entry.masks.find((m) => m.id === 'big-src')!.src).toBeUndefined();
    expect(entry.masks.find((m) => m.id === 'good-src')!.src).toBe('data:image/webp;base64,AAAA');
    expect(entry.masks.find((m) => m.id === 'evil-src')!.src).toBeUndefined();
  });

  it('tolerates junk storage', () => {
    localStorage.setItem(maskLayoutStorageKey('u'), 'not json');
    expect(loadMaskLayouts('u')).toEqual([]);
    localStorage.setItem(maskLayoutStorageKey('u'), '{"an":"object"}');
    expect(loadMaskLayouts('u')).toEqual([]);
  });

  it('upsert replaces the entry for a key, keeps its name, and empty masks DELETE it', () => {
    let layouts = upsertMaskLayout([], 'k1', [mask('a')], 1);
    layouts = layouts.map((e) => ({ ...e, name: 'Work window' }));
    layouts = upsertMaskLayout(layouts, 'k1', [mask('b')], 2);
    expect(layouts).toHaveLength(1);
    expect(layouts[0].name).toBe('Work window');
    expect(layouts[0].masks[0].id).toBe('b');
    expect(layouts[0].lastUsed).toBe(2);
    layouts = upsertMaskLayout(layouts, 'k1', [], 3);
    expect(layouts).toEqual([]);
  });

  it('caps at MASK_LAYOUTS_MAX, dropping the least recently used', () => {
    let layouts = upsertMaskLayout([], 'oldest', [mask('m')], 0);
    for (let i = 1; i <= MASK_LAYOUTS_MAX; i++) {
      layouts = upsertMaskLayout(layouts, `k${i}`, [mask('m')], i);
    }
    expect(layouts).toHaveLength(MASK_LAYOUTS_MAX);
    expect(findMaskLayout(layouts, 'oldest')).toBeUndefined();
    expect(findMaskLayout(layouts, 'k1')).toBeDefined();
  });
});
