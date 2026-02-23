/**
 * Local test harness for youtube-playwright.js
 *
 * Runs the YouTube connector with real Playwright (headed Chromium) so you can
 * log in manually and inspect the collected data locally.
 *
 * Uses a persistent browser profile stored in ./chrome-profile so that your
 * Google session is saved between runs — log in once, reuse forever.
 *
 * Prerequisites:
 *   npm i -D playwright
 *   npx playwright install chromium
 *
 * Usage:
 *   node youtube/local-harness.youtube.js
 *
 * Output:
 *   ./youtube-export.json  (written when the run completes)
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Persistent profile directory — session cookies are saved here between runs.
// Relative to this harness file so it stays inside the project.
const PROFILE_DIR = path.join(__dirname, 'chrome-profile');

// ─── Terminal input helper ──────────────────────────────────────────────────

/**
 * Returns a Promise that resolves when the user presses Enter.
 * Used as an optional shortcut inside promptUser.
 */
function waitForEnter() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', () => {
      rl.close();
      resolve();
    });
  });
}

// ─── Shim factory ───────────────────────────────────────────────────────────

/**
 * Builds a `pageShim` that wraps a Playwright `page` and exposes the
 * runner-style API used by the connector.
 */
function createPageShim(playwrightPage) {
  return {
    // ── Playwright pass-throughs ──────────────────────────────────────────
    async goto(url) {
      return playwrightPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    },

    async evaluate(script) {
      // Playwright page.evaluate() accepts raw strings directly — no wrapping needed.
      return playwrightPage.evaluate(script);
    },

    // ── Runner-style API ──────────────────────────────────────────────────
    async sleep(ms) {
      return new Promise(r => setTimeout(r, ms));
    },

    setData(key, value) {
      if (typeof value === 'object' && value !== null) {
        const preview = JSON.stringify(value);
        const display = preview.length > 200 ? preview.slice(0, 200) + '…' : preview;
        console.log(`[setData] ${key}: ${display}`);
      } else {
        console.log(`[setData] ${key}: ${value}`);
      }
    },

    setProgress(obj) {
      const phase = obj.phase
        ? `[${obj.phase.step}/${obj.phase.total}] ${obj.phase.label}`
        : '';
      const count = obj.count != null ? ` (count: ${obj.count})` : '';
      console.log(`[progress] ${phase} ${obj.message || ''}${count}`.trim());
    },

    async showBrowser(url) {
      // Browser is already headed; just navigate.
      console.log(`[showBrowser] Navigating to ${url}`);
      return playwrightPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    },

    goHeadless() {
      // Cannot switch to headless mid-session in standard Playwright.
      console.warn('[goHeadless] Warning: headless switch not supported locally — continuing headed.');
    },

    /**
     * Polls `callback` every `intervalMs` ms until it returns truthy.
     * Also resolves immediately if the user presses Enter in the terminal.
     *
     * @param {string}   message     - Instruction shown to the user.
     * @param {Function} callback    - Async predicate; resolves when truthy.
     * @param {number}   intervalMs  - Polling interval in milliseconds.
     */
    async promptUser(message, callback, intervalMs = 2000) {
      console.log('\n─────────────────────────────────────────────');
      console.log(`[promptUser] ${message}`);
      console.log('             Press Enter to continue once done, or wait for auto-detect.');
      console.log('─────────────────────────────────────────────\n');

      return new Promise(resolve => {
        let done = false;

        // Poll the callback
        const poll = async () => {
          if (done) return;
          try {
            const ok = await callback();
            if (ok) {
              done = true;
              resolve();
              return;
            }
          } catch (_) {
            // Ignore poll errors; keep trying
          }
          if (!done) setTimeout(poll, intervalMs);
        };

        // Allow Enter to shortcut
        waitForEnter().then(() => {
          if (!done) {
            done = true;
            resolve();
          }
        });

        poll();
      });
    }
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log('=== YouTube Connector — Local Harness ===');
  console.log(`Profile dir: ${PROFILE_DIR}`);
  console.log('Launching headed Chromium with persistent session...\n');

  // launchPersistentContext saves cookies/localStorage between runs so you
  // only need to log in to Google once.
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    slowMo: 50,
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const playwrightPage = await context.newPage();
  const pageShim = createPageShim(playwrightPage);

  // Inject shim as global `page` — the connector file uses `page.*` directly.
  global.page = pageShim;

  let result;
  try {
    // Load and execute the connector.
    // The connector's top-level IIFE runs immediately on require.
    // We capture its return value by temporarily monkey-patching the shim's
    // setData for the 'result' key.
    const connectorPath = path.join(__dirname, 'youtube-playwright.js');

    // Wrap execution in a Promise so we can await the connector's IIFE.
    result = await new Promise((resolve, reject) => {
      // Override setData to capture the final result payload
      const originalSetData = pageShim.setData.bind(pageShim);
      pageShim.setData = function (key, value) {
        originalSetData(key, value);
        if (key === 'result') resolve(value);
      };

      try {
        // require() executes the IIFE synchronously (returns the Promise from
        // the async IIFE). We catch any top-level throw here.
        const connectorPromise = require(connectorPath);
        if (connectorPromise && typeof connectorPromise.then === 'function') {
          connectorPromise.then(r => {
            // Fallback: if setData('result') was never called but the IIFE
            // returned { success, data }, use that.
            if (r && r.data) resolve(r.data);
          }).catch(reject);
        }
      } catch (err) {
        reject(err);
      }

      // Safety timeout: resolve with whatever we have after 30 minutes
      setTimeout(() => resolve(null), 30 * 60 * 1000);
    });
  } catch (err) {
    console.error('\n[harness] Connector threw an error:', err.message);
    result = null;
  }

  await context.close();

  if (!result) {
    console.error('\n[harness] No result captured — check errors above.');
    process.exit(1);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const summary = result.exportSummary || {};
  console.log('\n═══════════════════════════════════════════');
  console.log('  Export Summary');
  console.log('═══════════════════════════════════════════');
  console.log(`  Profile:        ${summary.profile || 'n/a'}`);
  console.log(`  Subscriptions:  ${summary.subscriptions ?? 'n/a'}`);
  console.log(`  Playlists:      ${summary.playlists ?? 'n/a'}`);
  console.log(`  Playlist items: ${summary.playlistItems ?? 'n/a'}`);
  console.log(`  Likes:          ${summary.likes ?? 'n/a'}`);
  console.log(`  Watch Later:    ${summary.watchLater ?? 'n/a'}`);
  console.log(`  History:        ${summary.history ?? 'n/a'}`);
  console.log('═══════════════════════════════════════════\n');

  const outputPath = path.join(process.cwd(), 'youtube-export.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`[harness] Output written to: ${outputPath}`);
})();
