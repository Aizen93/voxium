import { THEME_COLOR_KEYS } from '@voxium/shared';
import type { ThemeColors, ThemePatterns, ThemePattern, CommunityThemeData } from '@voxium/shared';
import { validateThemeColors, validateThemeName, validateThemePatterns, sanitizeSvg } from '@voxium/shared';

const PATTERN_STYLE_ID = 'vox-custom-patterns';

/**
 * Apply a custom theme's colors to the document root via inline CSS properties.
 * Sets data-theme="custom" so no built-in [data-theme] CSS selector matches.
 */
export function applyCustomThemeColors(colors: ThemeColors): void {
  document.documentElement.setAttribute('data-theme', 'custom');
  for (const key of THEME_COLOR_KEYS) {
    document.documentElement.style.setProperty(`--vox-${key}`, colors[key]);
  }
}

/**
 * Remove all custom CSS property overrides from the document root.
 * Call this before switching back to a built-in theme.
 */
export function clearCustomThemeColors(): void {
  for (const key of THEME_COLOR_KEYS) {
    document.documentElement.style.removeProperty(`--vox-${key}`);
  }
  clearCustomPatterns();
}

/**
 * Apply custom patterns to sidebar, channel, and chat areas via injected <style> tag.
 */
export function applyCustomPatterns(patterns: ThemePatterns | undefined): void {
  clearCustomPatterns();
  if (!patterns) return;

  const rules: string[] = [];

  const areaSelectors: Record<string, string> = {
    sidebar: '[data-theme="custom"] [class*="bg-vox-sidebar"]',
    channel: '[data-theme="custom"] [class*="bg-vox-channel"]',
    chat: '[data-theme="custom"] [class*="bg-vox-chat"]',
  };

  for (const [area, pattern] of Object.entries(patterns)) {
    if (!pattern || pattern.type === 'none') continue;
    const selector = areaSelectors[area];
    if (!selector) continue;

    const css = generatePatternCSS(pattern);
    if (css) {
      rules.push(`${selector} { ${css} }`);
    }
  }

  if (rules.length === 0) return;

  const style = document.createElement('style');
  style.id = PATTERN_STYLE_ID;
  style.textContent = rules.join('\n');
  document.head.appendChild(style);
}

/** Remove the injected pattern <style> tag. */
export function clearCustomPatterns(): void {
  const existing = document.getElementById(PATTERN_STYLE_ID);
  if (existing) existing.remove();
}

/**
 * Generate CSS declarations for a single ThemePattern.
 */
function generatePatternCSS(pattern: ThemePattern): string | null {
  const { type, color, opacity, size, angle } = pattern;

  // Parse hex color to RGB for rgba() usage
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  const rgba = `rgba(${r}, ${g}, ${b}, ${opacity})`;

  switch (type) {
    case 'stripes': {
      const a = angle ?? -45;
      const s = size ?? 20;
      return `background-image: repeating-linear-gradient(${a}deg, transparent, transparent ${s}px, ${rgba} ${s}px, ${rgba} ${s + 1}px); background-repeat: repeat;`;
    }

    case 'grid': {
      const s = size ?? 40;
      return `background-image: linear-gradient(${rgba} 1px, transparent 1px), linear-gradient(90deg, ${rgba} 1px, transparent 1px); background-size: ${s}px ${s}px;`;
    }

    case 'dots': {
      const s = size ?? 24;
      const dotR = Math.max(1, Math.round(s * 0.06));
      return `background-image: radial-gradient(circle, ${rgba} ${dotR}px, transparent ${dotR}px); background-size: ${s}px ${s}px;`;
    }

    case 'crosshatch': {
      const s = size ?? 20;
      const a = angle ?? 45;
      return `background-image: repeating-linear-gradient(${a}deg, transparent, transparent ${s}px, ${rgba} ${s}px, ${rgba} ${s + 1}px), repeating-linear-gradient(${-a}deg, transparent, transparent ${s}px, ${rgba} ${s}px, ${rgba} ${s + 1}px); background-repeat: repeat;`;
    }

    case 'custom-svg': {
      if (!pattern.svgData) return null;
      const sanitized = sanitizeSvg(pattern.svgData);
      if (!sanitized) return null;
      // Inject fill color and opacity into the SVG wrapper
      const wrappedSvg = injectSvgColorAndOpacity(sanitized, color, opacity);
      const encoded = encodeURIComponent(wrappedSvg)
        .replace(/'/g, '%27')
        .replace(/"/g, '%22');
      const s = size ?? 200;
      return `background-image: url("data:image/svg+xml,${encoded}"); background-repeat: repeat; background-size: ${s}px ${s}px;`;
    }

    default:
      return null;
  }
}

/**
 * Inject fill color and opacity into SVG if not already set.
 * Wraps content in a <g> with the desired fill and opacity.
 */
function injectSvgColorAndOpacity(svg: string, color: string, opacity: number): string {
  // If the SVG already has fill attributes in the root <g>, leave it alone
  // Otherwise, wrap the inner content
  return svg.replace(
    /(<svg[^>]*>)([\s\S]*)(<\/svg>)/i,
    (_, open, inner, close) =>
      `${open}<g opacity="${opacity}" fill="${color}">${inner}</g>${close}`,
  );
}

/**
 * Convert a ThemePattern to a React CSSProperties object for inline style use.
 * Used by the MiniPreview to render patterns without touching the document root.
 */
export function getPatternStyle(pattern: ThemePattern | undefined): React.CSSProperties {
  if (!pattern || pattern.type === 'none') return {};
  const css = generatePatternCSS(pattern);
  if (!css) return {};

  const style: Record<string, string> = {};
  // Parse "prop: value; prop: value;" into object
  for (const decl of css.split(';')) {
    const trimmed = decl.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;
    const prop = trimmed.slice(0, colonIdx).trim();
    const val = trimmed.slice(colonIdx + 1).trim();
    // Convert kebab-case to camelCase
    const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    style[camel] = val;
  }
  return style as React.CSSProperties;
}

/**
 * Export a theme as a downloadable JSON file.
 */
export function exportTheme(theme: CommunityThemeData): void {
  const json = JSON.stringify(theme, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${theme.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.voxtheme.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Import and validate a theme from a JSON file.
 * Returns the validated theme data or throws an error with a descriptive message.
 */
export async function importTheme(file: File): Promise<CommunityThemeData> {
  const text = await file.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON file');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Theme file must contain a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  // Validate name
  if (!obj.name || typeof obj.name !== 'string') {
    throw new Error('Theme must have a name');
  }
  const nameErr = validateThemeName(obj.name);
  if (nameErr) throw new Error(nameErr);

  // Validate colors
  if (!obj.colors || typeof obj.colors !== 'object') {
    throw new Error('Theme must have a colors object');
  }
  const colorsErr = validateThemeColors(obj.colors as Record<string, string>);
  if (colorsErr) throw new Error(colorsErr);

  // Validate patterns if present
  let patterns: CommunityThemeData['patterns'];
  if (obj.patterns && typeof obj.patterns === 'object') {
    const patternsErr = validateThemePatterns(obj.patterns as Record<string, unknown>);
    if (patternsErr) throw new Error(patternsErr);
    patterns = obj.patterns as CommunityThemeData['patterns'];
  }

  // Build validated theme data
  const theme: CommunityThemeData = {
    name: obj.name,
    description: typeof obj.description === 'string' ? obj.description : '',
    tags: Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string').slice(0, 5) : [],
    colors: obj.colors as ThemeColors,
    patterns,
    version: typeof obj.version === 'number' ? obj.version : 1,
  };

  return theme;
}

/**
 * Get colors for a built-in theme by reading computed CSS properties.
 * Temporarily sets the data-theme attribute, reads values, then restores.
 */
export function getBuiltInThemeColors(themeId: string): ThemeColors {
  const original = document.documentElement.getAttribute('data-theme');
  // Temporarily clear inline styles that might override
  const savedStyles: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) {
    const prop = `--vox-${key}`;
    const val = document.documentElement.style.getPropertyValue(prop);
    if (val) {
      savedStyles[prop] = val;
      document.documentElement.style.removeProperty(prop);
    }
  }

  document.documentElement.setAttribute('data-theme', themeId);
  // Force style recalculation
  const computed = getComputedStyle(document.documentElement);
  const colors: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) {
    colors[key] = computed.getPropertyValue(`--vox-${key}`).trim();
  }

  // Restore
  if (original) {
    document.documentElement.setAttribute('data-theme', original);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  for (const [prop, val] of Object.entries(savedStyles)) {
    document.documentElement.style.setProperty(prop, val);
  }

  return colors as ThemeColors;
}
