import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DISCOVERY_TIERS } from '@voxium/shared';

/**
 * The activity crest: one per tier, labelled with the tier name and the top
 * fraction it stands for, one to five stars for the rank, and SVG gradient
 * ids that never collide between two badges on the same page.
 */

const t = (k: string, o?: Record<string, unknown>) => (o && 'percent' in o ? `${k}:${o.tier}:${o.percent}` : k);
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t }) };
});

import { TierBadge, tierPercent } from '../../components/discovery/TierBadge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('TierBadge', () => {
  it('renders every tier with its label (name + top fraction), its rank in stars, and the tier on the element', () => {
    const expectedStars = { bronze: 1, silver: 2, gold: 3, platinum: 4, diamond: 5 };
    const expectedPercent = { bronze: 50, silver: 25, gold: 10, platinum: 3, diamond: 1 };
    for (const tier of DISCOVERY_TIERS) {
      act(() => { root.render(<TierBadge tier={tier} />); });
      const badge = container.querySelector('[data-testid="discovery-tier"]')!;
      expect(badge.getAttribute('data-tier')).toBe(tier);
      expect(tierPercent(tier)).toBe(expectedPercent[tier]);
      const label = `discovery.tier.badgeLabel:discovery.tier.${tier}:${expectedPercent[tier]}`;
      expect(badge.getAttribute('title')).toBe(label);
      expect(container.querySelector('svg')!.getAttribute('aria-label')).toBe(label);
      // the shield, the bolt and the stars: 2 shield paths + 1 outline + 1 bolt + N stars (the clip path lives in defs)
      expect(container.querySelector('svg')!.querySelectorAll(':scope > path')).toHaveLength(3 + 1 + expectedStars[tier]);
    }
  });

  it('sizes from the width (the crest is 9/8 as tall) and keeps gradient ids unique per badge', () => {
    act(() => { root.render(<><TierBadge tier="gold" size={40} /><TierBadge tier="gold" size={22} /></>); });
    const svgs = container.querySelectorAll('svg');
    expect(svgs).toHaveLength(2);
    expect(svgs[0].getAttribute('width')).toBe('40');
    expect(svgs[0].getAttribute('height')).toBe('45');
    const ids = Array.from(container.querySelectorAll('linearGradient')).map((g) => g.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    // every fill references a gradient that exists in the same document
    for (const path of container.querySelectorAll('path[fill^="url(#"]')) {
      const id = path.getAttribute('fill')!.slice(5, -1);
      expect(container.querySelector(`[id="${id}"]`)).not.toBeNull();
    }
  });
});
