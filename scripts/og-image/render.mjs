// Renders og-image.html (1200x630) to apps/desktop/public/og-image.png — the
// Open Graph / Twitter share image — with the project's own Chromium
// (Playwright) and self-hosted Inter files, so the result is reproducible.
//
//   node scripts/og-image/render.mjs            # writes the PNG in place
//   node scripts/og-image/render.mjs --crops    # also writes two 630x630 crops
//                                               # next to this script, to check
//                                               # what a messenger's square
//                                               # thumbnail will show
//
// Design rule the HTML follows: everything sits inside the central 630x630
// square. Messengers that show a small thumbnail (WhatsApp, Signal, iMessage)
// crop a square out of the middle of the image, so content near the edges
// is what disappears. Keep the PNG well under 300 KB — above that WhatsApp
// drops the preview entirely.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'apps', 'desktop', 'public', 'og-image.png');
const WIDTH = 1200;
const HEIGHT = 630;
const SQUARE_X = (WIDTH - HEIGHT) / 2;
const crops = process.argv.includes('--crops');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(HERE, 'og-image.html')).href);
  await page.evaluate(() => document.fonts.ready);
  const weights = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.weight));
  if (weights.length === 0) throw new Error('Inter did not load — is @fontsource/inter installed at the repo root?');

  // Refuse to write an image whose content leaves the safe square.
  const box = await page.evaluate(() => {
    const r = document.querySelector('.stack').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.stack > *')].map((el) => el.getBoundingClientRect());
    return {
      left: Math.min(...boxes.map((b) => b.left)), right: Math.max(...boxes.map((b) => b.right)),
      top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom)), stack: r.width,
    };
  });
  if (box.left < SQUARE_X || box.right > SQUARE_X + HEIGHT) {
    throw new Error(`content spans x ${Math.round(box.left)}..${Math.round(box.right)}, outside the central square ${SQUARE_X}..${SQUARE_X + HEIGHT}`);
  }
  console.log(`content: x ${Math.round(box.left)}..${Math.round(box.right)}, y ${Math.round(box.top)}..${Math.round(box.bottom)} (safe square x ${SQUARE_X}..${SQUARE_X + HEIGHT})`);

  await page.screenshot({ path: OUT, type: 'png' });
  const bytes = statSync(OUT).size;
  console.log(`wrote ${path.relative(ROOT, OUT)} — ${bytes} bytes${bytes > 300_000 ? '  ← OVER 300 KB, WhatsApp will drop the preview' : ''}`);

  if (crops) {
    await page.screenshot({ path: path.join(HERE, 'crop-centred.png'), clip: { x: SQUARE_X, y: 0, width: HEIGHT, height: HEIGHT } });
    await page.screenshot({ path: path.join(HERE, 'crop-offset.png'), clip: { x: 190, y: 0, width: HEIGHT, height: HEIGHT } });
    console.log('wrote crop-centred.png and crop-offset.png next to this script (git-ignored)');
  }
} finally {
  await browser.close();
}
