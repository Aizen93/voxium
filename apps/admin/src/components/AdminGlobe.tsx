import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import createGlobe from 'cobe';
import type { GeoStat, InfraServer } from '@voxium/shared';

/** Approximate centroids for ISO 3166-1 alpha-2 country codes */
const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  AF: [33, 65], AL: [41, 20], DZ: [28, 3], AD: [42.5, 1.5], AO: [-12.5, 18.5],
  AG: [17.05, -61.8], AR: [-34, -64], AM: [40, 45], AU: [-25, 134], AT: [47.3, 13.3],
  AZ: [40.5, 47.5], BS: [24, -76], BH: [26, 50.5], BD: [24, 90], BB: [13.2, -59.5],
  BY: [53, 28], BE: [50.8, 4.3], BZ: [17.2, -88.7], BJ: [9.3, 2.3], BT: [27.5, 90.5],
  BO: [-17, -65], BA: [44, 17.8], BW: [-22, 24], BR: [-10, -55], BN: [4.5, 114.7],
  BG: [43, 25], BF: [13, -1.7], BI: [-3.5, 30], KH: [13, 105], CM: [6, 12.5],
  CA: [56, -96], CV: [16, -24], CF: [7, 21], TD: [15, 19], CL: [-30, -71],
  CN: [35, 105], CO: [4, -72], KM: [-12.2, 44.3], CD: [-3, 23.6], CG: [-1, 15.8],
  CR: [10, -84], CI: [7.5, -5.5], HR: [45.2, 15.5], CU: [22, -80], CY: [35, 33],
  CZ: [49.7, 15.5], DK: [56, 10], DJ: [11.5, 43], DM: [15.4, -61.4], DO: [19, -70.7],
  EC: [-2, -77.5], EG: [27, 30], SV: [13.8, -88.9], GQ: [1.7, 10.5], ER: [15.3, 39],
  EE: [59, 26], SZ: [-26.5, 31.5], ET: [8, 38], FJ: [-18, 178], FI: [64, 26],
  FR: [46, 2], GA: [-1, 11.8], GM: [13.5, -15.4], GE: [42, 43.5], DE: [51, 10],
  GH: [8, -1.2], GR: [39, 22], GD: [12.1, -61.7], GT: [15.5, -90.3], GN: [11, -10],
  GW: [12, -15], GY: [5, -59], HT: [19, -72.3], HN: [15, -86.5], HU: [47, 20],
  IS: [65, -18], IN: [22, 78], ID: [-5, 120], IR: [32, 53], IQ: [33, 44],
  IE: [53, -8], IL: [31.5, 34.8], IT: [42.8, 12.8], JM: [18.1, -77.3], JP: [36, 138],
  JO: [31, 36], KZ: [48, 68], KE: [1, 38], KI: [1.5, 173], KP: [40, 127],
  KR: [37, 127.5], KW: [29.5, 47.8], KG: [41, 75], LA: [18, 105], LV: [57, 25],
  LB: [33.8, 35.8], LS: [-29.5, 28.5], LR: [6.5, -9.5], LY: [27, 17], LI: [47.2, 9.5],
  LT: [56, 24], LU: [49.8, 6.1], MG: [-20, 47], MW: [-13.5, 34], MY: [2.5, 112.5],
  MV: [3.2, 73], ML: [17, -4], MT: [35.9, 14.4], MH: [7.1, 171.2], MR: [20, -10.5],
  MU: [-20.3, 57.6], MX: [23, -102], FM: [6.9, 158.2], MD: [47, 29], MC: [43.7, 7.4],
  MN: [46, 105], ME: [42.5, 19.3], MA: [32, -5], MZ: [-18, 35], MM: [22, 98],
  NA: [-22, 17], NR: [-0.5, 166.9], NP: [28, 84], NL: [52.1, 5.3], NZ: [-42, 174],
  NI: [13, -85], NE: [16, 8], NG: [10, 8], NO: [62, 10], OM: [21, 57],
  PK: [30, 70], PW: [7.5, 134.6], PA: [9, -80], PG: [-6, 147], PY: [-23, -58],
  PE: [-10, -76], PH: [12, 122], PL: [52, 20], PT: [39.5, -8], QA: [25.5, 51.2],
  RO: [46, 25], RU: [60, 100], RW: [-2, 30], KN: [17.3, -62.7], LC: [13.9, -61],
  VC: [13.3, -61.2], WS: [-13.8, -172], SM: [43.9, 12.4], ST: [1, 7],
  SA: [24, 45], SN: [14, -14.5], RS: [44, 21], SC: [-4.7, 55.5], SL: [8.5, -11.8],
  SG: [1.4, 103.8], SK: [48.7, 19.7], SI: [46, 15], SB: [-8, 159], SO: [5, 46],
  ZA: [-29, 24], SS: [7, 30], ES: [40, -4], LK: [7, 81], SD: [15, 30],
  SR: [4, -56], SE: [62, 15], CH: [47, 8], SY: [35, 38], TW: [23.5, 121],
  TJ: [39, 71], TZ: [-6, 35], TH: [15, 100], TL: [-8.5, 126], TG: [8, 1.2],
  TO: [-21.2, -175.2], TT: [10.4, -61.3], TN: [34, 9], TR: [39, 35], TM: [40, 60],
  TV: [-8, 178], UG: [1, 32], UA: [49, 32], AE: [24, 54], GB: [54, -2],
  US: [38, -97], UY: [-33, -56], UZ: [41, 64], VU: [-16, 167], VA: [41.9, 12.5],
  VE: [8, -66], VN: [16, 108], YE: [15, 48], ZM: [-15, 28], ZW: [-20, 30],
  PS: [31.9, 35.2], XK: [42.6, 21], HK: [22.3, 114.2], MO: [22.2, 113.5],
  PR: [18.2, -66.5], RE: [-21.1, 55.5], GP: [16.2, -61.6], MQ: [14.6, -61],
  GF: [4, -53], NC: [-22.3, 166.5], PF: [-17.7, -149.4],
};

/** Render a country flag via Twemoji CDN (converts country code to regional indicator emoji codepoints) */
function CountryFlag({ code, size = 20 }: { code: string; size?: number }) {
  // Regional indicator codepoints: A=1F1E6, B=1F1E7, etc.
  const cp1 = (0x1f1e6 + code.toUpperCase().charCodeAt(0) - 65).toString(16);
  const cp2 = (0x1f1e6 + code.toUpperCase().charCodeAt(1) - 65).toString(16);
  return (
    <img
      src={`https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/${cp1}-${cp2}.svg`}
      alt={code}
      width={size}
      height={size}
      className="inline-block"
      loading="lazy"
    />
  );
}

interface AdminGlobeProps {
  geoStats: GeoStat[];
  infraServers: InfraServer[];
  fullPage?: boolean;
}

interface GeoStatWithCoords extends GeoStat {
  lat: number;
  lng: number;
}

/** Project a lat/lng to 2D screen coords matching cobe's internal projection */
function project(
  lat: number, lng: number,
  phi: number, theta: number, scale: number,
  cx: number, cy: number, radius: number,
): { x: number; y: number; visible: boolean } {
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;

  // Forward projection matching cobe's rotation matrix J(theta, phi)
  // applied to world coords [cos(lat)*cos(lng), sin(lat), -cos(lat)*sin(lng)]
  const sx = Math.cos(latRad) * Math.cos(lngRad + phi);
  const sy = Math.cos(theta) * Math.sin(latRad) + Math.sin(theta) * Math.cos(latRad) * Math.sin(lngRad + phi);
  const sz = Math.sin(theta) * Math.sin(latRad) - Math.cos(theta) * Math.cos(latRad) * Math.sin(lngRad + phi);

  // cobe renders the globe at 80% of the canvas half-size (shader: dot(a,a) <= 0.64)
  const r = radius * 0.8;

  return {
    x: cx + sx * r * scale,
    y: cy - sy * r * scale,
    visible: sz > 0,
  };
}

export function AdminGlobe({ geoStats, infraServers, fullPage }: AdminGlobeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Initial rotation: center on Europe (~15°E). Center longitude = -(phi + π/2)
  const phiRef = useRef(-Math.PI / 2 - (15 * Math.PI) / 180);
  const thetaRef = useRef(0.3);
  const scaleRef = useRef(1);
  const dragRef = useRef({ active: false, lastX: 0, lastY: 0 });
  const [tooltip, setTooltip] = useState<{ x: number; y: number; stat: GeoStat } | null>(null);

  // Resolve country centroids for each stat
  const statsWithCoords = useMemo<GeoStatWithCoords[]>(() =>
    geoStats
      .map((g) => {
        const coords = COUNTRY_CENTROIDS[g.countryCode];
        if (!coords) return null;
        return { ...g, lat: coords[0], lng: coords[1] };
      })
      .filter((g): g is GeoStatWithCoords => g !== null),
    [geoStats],
  );

  const maxCount = Math.max(...geoStats.map((g) => g.count), 1);
  const globeSize = fullPage ? 600 : 420;

  const handleCanvasMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || statsWithCoords.length === 0 || dragRef.current.active) {
      setTooltip(null);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const radius = rect.width / 2;

    let closest: { dist: number; stat: GeoStat; x: number; y: number } | null = null;

    for (const g of statsWithCoords) {
      const p = project(g.lat, g.lng, phiRef.current, thetaRef.current, scaleRef.current, cx, cy, radius);
      if (!p.visible) continue;

      const dist = Math.sqrt((mouseX - p.x) ** 2 + (mouseY - p.y) ** 2);
      const hitRadius = 12 + (g.count / maxCount) * 10;

      if (dist < hitRadius && (!closest || dist < closest.dist)) {
        closest = { dist, stat: g, x: p.x, y: p.y };
      }
    }

    // Check infra servers too
    for (const s of infraServers) {
      const p = project(s.latitude, s.longitude, phiRef.current, thetaRef.current, scaleRef.current, cx, cy, radius);
      if (!p.visible) continue;
      const dist = Math.sqrt((mouseX - p.x) ** 2 + (mouseY - p.y) ** 2);
      if (dist < 16 && (!closest || dist < closest.dist)) {
        closest = { dist, stat: { countryCode: '', country: `${s.name} (${s.provider})`, count: 0 } as GeoStat, x: p.x, y: p.y };
      }
    }

    if (closest) {
      setTooltip({ x: closest.x, y: closest.y, stat: closest.stat });
    } else {
      setTooltip(null);
    }
  }, [statsWithCoords, maxCount, infraServers]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onPointerDown = (e: PointerEvent) => {
      dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
      setTooltip(null);
    };
    const onPointerUp = () => {
      dragRef.current.active = false;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragRef.current.active) return;
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      phiRef.current += dx * 0.005;
      thetaRef.current = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, thetaRef.current + dy * 0.005));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      scaleRef.current = Math.max(1, Math.min(4, scaleRef.current + delta));
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointermove', onPointerMove);

    // Small markers at each country (tiny dots)
    const userMarkers = statsWithCoords.map((g) => ({
      location: [g.lat, g.lng] as [number, number],
      size: 0.02 + (g.count / maxCount) * 0.04,
    }));

    const markers = userMarkers;

    // GitHub-style arcs: lines from the top country (hub) to all others
    const hub = statsWithCoords.length > 0
      ? statsWithCoords.reduce((a, b) => (a.count > b.count ? a : b))
      : null;
    const arcs = hub
      ? statsWithCoords
          .filter((g) => g.countryCode !== hub.countryCode)
          .map((g) => ({
            from: [hub.lat, hub.lng] as [number, number],
            to: [g.lat, g.lng] as [number, number],
            color: [0.36, 0.36, 0.97] as [number, number, number],
          }))
      : [];

    const dpr = Math.min(window.devicePixelRatio, 2);

    const globe = createGlobe(canvas, {
      devicePixelRatio: dpr,
      width: globeSize * dpr,
      height: globeSize * dpr,
      phi: phiRef.current,
      theta: thetaRef.current,
      dark: 1,
      diffuse: 1.4,
      mapSamples: 24000,
      mapBrightness: 8,
      baseColor: [0.18, 0.18, 0.32],
      markerColor: [0.36, 0.36, 0.97],
      glowColor: [0.2, 0.18, 0.4],
      markers,
      markerElevation: 0,
      arcs,
      arcColor: [0.36, 0.36, 0.97],
      arcWidth: 0.3,
      arcHeight: 0.15,
      scale: 1,
    });

    // Animation loop — update globe + project infra server overlays each frame
    let animFrame: number;
    const animate = () => {
      globe.update({
        phi: phiRef.current,
        theta: thetaRef.current,
        width: globeSize * dpr,
        height: globeSize * dpr,
        scale: scaleRef.current,
      });

      // Project infra server positions onto the overlay
      const overlay = overlayRef.current;
      if (overlay) {
        const cx = globeSize / 2;
        const cy = globeSize / 2;
        const radius = globeSize / 2;
        const children = overlay.children;
        for (let i = 0; i < infraServers.length; i++) {
          const s = infraServers[i];
          const el = children[i] as HTMLElement | undefined;
          if (!el) continue;
          const p = project(s.latitude, s.longitude, phiRef.current, thetaRef.current, scaleRef.current, cx, cy, radius);
          if (p.visible) {
            el.style.display = '';
            el.style.left = `${p.x}px`;
            el.style.top = `${p.y}px`;
            // Scale the coverage ring with zoom so it stays proportional to the globe
            const ring = el.firstElementChild as HTMLElement | null;
            if (ring) {
              const ringSize = globeSize * 0.22 * scaleRef.current;
              ring.style.width = `${ringSize}px`;
              ring.style.height = `${ringSize}px`;
            }
          } else {
            el.style.display = 'none';
          }
        }
      }

      animFrame = requestAnimationFrame(animate);
    };
    animFrame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animFrame);
      globe.destroy();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
    };
  }, [statsWithCoords, maxCount, fullPage, globeSize, infraServers]);

  const sorted = [...geoStats].sort((a, b) => b.count - a.count);
  const totalUsers = geoStats.reduce((sum, g) => sum + g.count, 0);

  return (
    <div className="rounded-lg bg-vox-bg-secondary border border-vox-border p-4">
      {!fullPage && (
        <h3 className="text-sm font-semibold text-vox-text-primary mb-3 flex items-center gap-2">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          Users by Country
        </h3>
      )}

      <div className={`flex gap-6 ${fullPage ? 'flex-col xl:flex-row items-center' : 'flex-col lg:flex-row items-center'}`}>
        {/* Globe */}
        <div className="flex-shrink-0 flex flex-col items-center gap-2">
          <div className="relative">
            <canvas
              ref={canvasRef}
              className="cursor-grab active:cursor-grabbing"
              style={{ width: globeSize, height: globeSize, maxWidth: '100%' }}
              onMouseMove={handleCanvasMove}
              onMouseLeave={() => setTooltip(null)}
            />
            {/* HTML overlay for infra server icons + coverage rings */}
            <div
              ref={overlayRef}
              className="absolute inset-0 pointer-events-none"
              style={{ width: globeSize, height: globeSize }}
            >
              {infraServers.map((s) => (
                <div
                  key={s.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ display: 'none' /* positioned by animation loop */ }}
                >
                  {/* Coverage radius ring — ~120ms RTT ≈ 2500km (size set dynamically by animation loop) */}
                  <div
                    className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-emerald-400/40 bg-emerald-400/8"
                  />
                  {/* Server icon */}
                  <div className="relative z-10 flex items-center justify-center h-5 w-5 rounded bg-emerald-500/90 shadow-lg shadow-emerald-500/30">
                    <svg className="h-3 w-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="2" width="20" height="8" rx="2" />
                      <rect x="2" y="14" width="20" height="8" rx="2" />
                      <circle cx="6" cy="6" r="1" fill="currentColor" stroke="none" />
                      <circle cx="6" cy="18" r="1" fill="currentColor" stroke="none" />
                    </svg>
                  </div>
                </div>
              ))}
            </div>
            {tooltip && (
              <div
                className="absolute z-10 pointer-events-none bg-vox-bg-tertiary/95 border border-vox-border rounded-lg px-3 py-2 shadow-lg"
                style={{
                  left: tooltip.x,
                  top: tooltip.y - 48,
                  transform: 'translateX(-50%)',
                }}
              >
                <p className="text-sm font-semibold text-vox-text-primary whitespace-nowrap flex items-center gap-1.5">
                  {tooltip.stat.countryCode ? <CountryFlag code={tooltip.stat.countryCode} size={16} /> : <span className="h-2 w-2 rounded-full bg-green-500 inline-block" />}
                  {tooltip.stat.country}
                </p>
                <p className="text-xs text-vox-text-muted">
                  {tooltip.stat.countryCode
                    ? `${tooltip.stat.count} user${tooltip.stat.count !== 1 ? 's' : ''}`
                    : 'Infrastructure server'}
                </p>
              </div>
            )}
          </div>
          <p className="text-[10px] text-vox-text-muted">Drag to rotate &middot; Scroll to zoom</p>
        </div>

        {/* Country list */}
        <div className={`w-full flex-1 overflow-y-auto space-y-1 ${fullPage ? 'max-h-[580px]' : 'max-h-[400px]'}`}>
          {sorted.length === 0 ? (
            <p className="text-xs text-vox-text-muted py-8 text-center">No location data yet</p>
          ) : (
            sorted.map((g) => (
              <div key={g.countryCode} className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-vox-bg-hover/50 transition-colors">
                <CountryFlag code={g.countryCode} size={fullPage ? 24 : 20} />
                <span className={`text-vox-text-primary truncate shrink-0 ${fullPage ? 'w-36 text-base' : 'w-28 text-sm'}`}>{g.country}</span>
                <span className={`font-semibold text-vox-text-primary shrink-0 tabular-nums text-right ${fullPage ? 'w-10 text-sm' : 'w-8 text-xs'}`}>{g.count}</span>
                <span className={`text-vox-text-muted shrink-0 tabular-nums text-right ${fullPage ? 'w-12 text-xs' : 'w-10 text-[11px]'}`}>{totalUsers > 0 ? ((g.count / totalUsers) * 100).toFixed(1) : '0.0'}%</span>
                <div className={`rounded-full bg-vox-bg-tertiary overflow-hidden flex-1 ${fullPage ? 'h-2' : 'h-1.5'}`}>
                  <div
                    className="h-full rounded-full bg-[#5b5bf7] transition-all duration-300"
                    style={{ width: `${(g.count / maxCount) * 100}%` }}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
