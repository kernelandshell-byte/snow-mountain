// A background tab's timers are throttled, down to one tick a minute after
// five minutes hidden. The first tick after the tab is shown then sees a gap
// of a minute since the last one, and the observer credited all of it as time
// spent looking at the page: a tab opened in the background and glanced at
// for a second could be kept as "read".
//
// Runs the observer's own source in a plain page with a stubbed chrome
// runtime, a clock the test moves, and its interval callback driven by hand,
// so the arithmetic is checked exactly and no real time passes. (In a real
// content script the page cannot reach the observer's clock or visibility,
// which is why this is not driven through the extension.)
//
//   node test/browser/run-dwell-gap.mjs

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const observerSource = await readFile(path.join(root, 'src/content/observer.js'), 'utf8');

const checks = [];
const check = (name, condition, detail) => {
  checks.push({ name, ok: !!condition });
  console.log(condition ? '  ok   ' + name : '  FAIL ' + name + '\n       ' + String(detail));
};

const browser = await chromium.launch();

// Loads a fresh page with the observer running against a fake clock. Returns
// helpers to move time, show or hide the page, and run one tick.
async function observed() {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>t</title><body>' + '<p>word </p>'.repeat(50),
  }));
  await page.addInitScript(() => {
    let now = 1_000_000;
    Date.now = () => now;
    window.__advance = (ms) => { now += ms; };
    window.__hidden = false;
    Object.defineProperty(document, 'visibilityState', { get: () => (window.__hidden ? 'hidden' : 'visible'), configurable: true });
    document.hasFocus = () => true;
    window.__sent = [];
    window.chrome = { runtime: { sendMessage: async (message) => { window.__sent.push(message.payload); return { capture: true }; } } };
    let tick = null;
    window.setInterval = (callback) => { tick = callback; return 1; };
    window.__tick = () => tick();
  });
  await page.goto('https://gap.example/article');
  await page.addScriptTag({ content: observerSource });
  return {
    page,
    tick: async (advanceMs, hidden) => {
      await page.evaluate(([ms, h]) => { window.__hidden = h; window.__advance(ms); window.__tick(); }, [advanceMs, hidden]);
      await page.waitForTimeout(30);
    },
    sent: () => page.evaluate(() => window.__sent.map((p) => p.focusedMs)),
  };
}

// Ordinary reading: two ticks in view reach the five second floor.
{
  const o = await observed();
  await o.tick(2500, false);
  await o.tick(2500, false);
  check('ordinary reading is offered once it reaches five seconds in view',
    (await o.sent()).length === 1, JSON.stringify(await o.sent()));
  await o.page.close();
}

// Hidden ticks earn nothing.
{
  const o = await observed();
  for (let i = 0; i < 6; i++) await o.tick(2500, true);
  check('a page that stays hidden is never offered', (await o.sent()).length === 0, JSON.stringify(await o.sent()));
  await o.page.close();
}

// The bug: hidden, a minute of throttled silence, then shown.
{
  const o = await observed();
  await o.tick(2500, true);
  await o.tick(60000, false);
  check('a minute of throttled silence is not counted as a minute of reading',
    (await o.sent()).length === 0, 'offered with focusedMs ' + JSON.stringify(await o.sent()));
  await o.tick(2500, false);
  const sent = await o.sent();
  check('but time actually spent in view afterwards still adds up',
    sent.length === 1 && sent[0] < 10000, JSON.stringify(sent));
  await o.page.close();
}

await browser.close();
const failed = checks.filter((c) => !c.ok).length;
console.log('\n' + (checks.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
