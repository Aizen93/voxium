import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GeoStat, InfraServer } from '@voxium/shared';

/**
 * The globe is created once per canvas size. A new marker list (user stats or
 * infrastructure servers) must reach the live globe through update() and must
 * never destroy and re-create it, which made it flicker on every refetch.
 */

const globe = { update: vi.fn(), destroy: vi.fn() };
const createGlobe = vi.fn((_canvas: unknown, _options: Record<string, unknown>) => globe);
vi.mock('cobe', () => ({ default: (canvas: unknown, options: Record<string, unknown>) => createGlobe(canvas, options) }));

import { AdminGlobe } from '../../components/AdminGlobe';

let container: HTMLDivElement;
let root: Root;
let rafCallbacks: Array<(t: number) => void>;

const stat = (countryCode: string, count: number): GeoStat => ({ countryCode, country: countryCode, count });
const infra = (id: string, name: string): InfraServer => ({
  id, name, country: 'FR', city: 'Paris', provider: 'p', latitude: 10, longitude: 20, createdAt: '',
});

/** Runs the animation frames queued so far (the globe is created in one). */
async function flushFrame() {
  const run = rafCallbacks;
  rafCallbacks = [];
  await act(async () => { run.forEach((cb) => cb(0)); });
}

async function render(props: { geoStats: GeoStat[]; infraServers: InfraServer[]; fullPage?: boolean }) {
  await act(async () => { root.render(<AdminGlobe {...props} />); });
  await flushFrame();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  rafCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { rafCallbacks.push(cb); return rafCallbacks.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('AdminGlobe', () => {
  it('creates the globe once with the markers and arcs of the stats', async () => {
    await render({ geoStats: [stat('FR', 10), stat('DE', 5)], infraServers: [] });

    expect(createGlobe).toHaveBeenCalledTimes(1);
    const options = createGlobe.mock.calls[0][1] as { markers: unknown[]; arcs: unknown[] };
    expect(options.markers).toHaveLength(2);
    expect(options.arcs).toHaveLength(1);
  });

  it('keeps the globe when the infrastructure server list is replaced', async () => {
    await render({ geoStats: [stat('FR', 10)], infraServers: [infra('a', 'A')] });
    await render({ geoStats: [stat('FR', 10)], infraServers: [infra('a', 'A'), infra('b', 'B')] });
    await render({ geoStats: [stat('FR', 10)], infraServers: [] });

    expect(createGlobe).toHaveBeenCalledTimes(1);
    expect(globe.destroy).not.toHaveBeenCalled();
  });

  it('pushes a changed stats list to the live globe with update() and does not re-create it', async () => {
    await render({ geoStats: [stat('FR', 10)], infraServers: [] });
    globe.update.mockClear();

    await render({ geoStats: [stat('FR', 10), stat('DE', 5), stat('ES', 2)], infraServers: [] });

    expect(createGlobe).toHaveBeenCalledTimes(1);
    expect(globe.destroy).not.toHaveBeenCalled();
    const call = globe.update.mock.calls.find(([state]) => 'markers' in state);
    expect(call).toBeDefined();
    expect(call![0].markers).toHaveLength(3);
    expect(call![0].arcs).toHaveLength(2);
  });

  it('re-creates the globe only when its size changes', async () => {
    await render({ geoStats: [stat('FR', 10)], infraServers: [], fullPage: false });
    await render({ geoStats: [stat('FR', 10)], infraServers: [], fullPage: true });

    expect(globe.destroy).toHaveBeenCalledTimes(1);
    expect(createGlobe).toHaveBeenCalledTimes(2);
  });

  it('draws the markers it already holds into a globe created after a stats change', async () => {
    await render({ geoStats: [stat('FR', 10)], infraServers: [], fullPage: false });
    await render({ geoStats: [stat('FR', 10), stat('DE', 5)], infraServers: [], fullPage: true });

    const options = createGlobe.mock.calls[1][1] as { markers: unknown[] };
    expect(options.markers).toHaveLength(2);
  });
});
