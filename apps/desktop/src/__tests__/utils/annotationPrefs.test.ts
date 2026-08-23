import { describe, it, expect } from 'vitest';
import { normalizeHexColor, pushRecentColor, clampTextSize, loadAnnotationPrefs, saveAnnotationPrefs, RECENT_COLORS_MAX } from '../../utils/annotationPrefs';

describe('annotationPrefs', () => {
  it('normalizeHexColor: widens #rgb, drops alpha, lowercases, rejects anything else', () => {
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc');
    expect(normalizeHexColor('#FF3B30')).toBe('#ff3b30');
    expect(normalizeHexColor('#ff3b3080')).toBe('#ff3b30');
    expect(normalizeHexColor(' #ff3b30 ')).toBe('#ff3b30');
    for (const bad of ['red', '#ff3b3', '#ggg', 'ff3b30', '#ff3b30ff00', '']) expect(normalizeHexColor(bad)).toBeNull();
  });

  it('pushRecentColor moves to the front, de-duplicates and caps', () => {
    let recent: string[] = [];
    for (let i = 0; i < RECENT_COLORS_MAX + 2; i++) recent = pushRecentColor(recent, `#${String(i).padStart(6, '0')}`);
    expect(recent).toHaveLength(RECENT_COLORS_MAX);
    expect(recent[0]).toBe('#000007');
    expect(pushRecentColor(recent, '#000003')[0]).toBe('#000003');
    expect(pushRecentColor(recent, '#000003')).toHaveLength(RECENT_COLORS_MAX);
  });

  it('clampTextSize keeps to the wire range', () => {
    expect(clampTextSize(0)).toBe(0.012);
    expect(clampTextSize(1)).toBe(0.2);
    expect(clampTextSize(0.05)).toBe(0.05);
  });

  it('load validates every field and tolerates junk', () => {
    saveAnnotationPrefs({ inkMode: 'vanishing', textSize: 0.07, recentColors: ['#ABC', 'nope', '#ff3b30', '#ff3b30'] });
    expect(loadAnnotationPrefs()).toEqual({ inkMode: 'vanishing', textSize: 0.07, recentColors: ['#aabbcc', '#ff3b30'] });
    localStorage.setItem('vox:annotations:prefs', JSON.stringify({ textSize: 'big', recentColors: 'x' }));
    expect(loadAnnotationPrefs()).toEqual({ inkMode: 'persistent', textSize: 0.045, recentColors: [] });
    localStorage.removeItem('vox:annotations:prefs');
  });
});
