// Starts each browser the end-to-end suite uses and renders one page in it.
// playwright-system-deps.sh runs this only when the system packages could not
// be installed: Playwright refuses to launch a browser whose shared libraries
// are missing, so a browser that starts here can run the suite.
import { chromium, firefox } from '@playwright/test';

let failed = false;
for (const [name, browserType] of [
  ['chromium', chromium],
  ['firefox', firefox],
]) {
  let browser;
  try {
    browser = await browserType.launch();
    const page = await browser.newPage();
    await page.setContent('<p id="probe">probe</p>');
    const text = await page.textContent('#probe');
    if (text !== 'probe') throw new Error(`rendered "${text}" instead of the probe text`);
    console.log(`${name}: starts and renders`);
  } catch (err) {
    failed = true;
    const reason = err instanceof Error ? err.message : String(err);
    // Playwright's "missing dependencies" message lists the libraries on the lines that follow
    console.error(`${name}: does not start\n${reason}`);
  } finally {
    if (browser) {
      await browser.close().catch((closeErr) => {
        console.warn(`${name}: could not close the probe browser: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
      });
    }
  }
}

process.exit(failed ? 1 : 0);
