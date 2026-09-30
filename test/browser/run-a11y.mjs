// The things a person who does not use the interface the way its author does
// depends on: a heading and a main landmark to jump to, the state of a toggle
// in something other than its colour, state that survives forced colours
// (Windows High Contrast), and nothing that needs sideways scrolling at 320px,
// which is what 400% zoom on a laptop leaves.
//
// The full axe-core audit is not run here, because it is a dependency and
// this repository has none; it came back clean on every surface when it was
// run by hand. These are the checks that would have caught what it did not.
//
//   node test/browser/run-a11y.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checks = [];
const check = (name, condition, detail) => {
  checks.push({ name, ok: !!condition });
  console.log(condition ? '  ok   ' + name : '  FAIL ' + name + '\n       ' + String(detail));
};

async function launch(options = {}) {
  const context = await chromium.launchPersistentContext('', {
    headless: false, viewport: { width: 900, height: 800 }, ...options,
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const base = 'chrome-extension://' + new URL(worker.url()).host;
  const admin = await context.newPage();
  await admin.goto(base + '/src/ui/options/options.html');
  await admin.evaluate(async () => {
    const { CORPUS } = await import('/test/fixtures/corpus.js');
    const { MSG } = await import('/src/shared/messages.js');
    await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: { setupComplete: true, mode: 'broad' } });
    let age = 0;
    for (const doc of CORPUS.slice(0, 8)) {
      await chrome.runtime.sendMessage({ type: MSG.PAGE_CONTENT, payload: {
        url: doc.url, title: doc.title, text: doc.text, capturedAt: Date.now() - age++ * 86400000 } });
    }
  });
  await admin.close();
  return { context, base };
}

// --- structure, and state that is not only a colour ------------------------
{
  const { context, base } = await launch();
  const popupTab = { id: 1, url: 'https://new.example/a' };
  for (const [name, url, tab] of [
    ['search', '/src/ui/search/search.html'],
    ['popup', '/src/ui/popup/popup.html', popupTab],
    ['options', '/src/ui/options/options.html'],
    ['setup', '/src/ui/setup/setup.html'],
  ]) {
    const page = await context.newPage();
    if (tab) await page.addInitScript((t) => { chrome.tabs.query = () => Promise.resolve([t]); }, tab);
    await page.goto(base + url);
    await page.waitForTimeout(500);
    const structure = await page.evaluate(() => ({
      h1: document.querySelectorAll('h1').length,
      main: document.querySelectorAll('main, [role="main"]').length,
    }));
    check(name + ' has a level-one heading', structure.h1 >= 1, JSON.stringify(structure));
    if (name !== 'setup') check(name + ' has a main landmark', structure.main === 1, JSON.stringify(structure));
    await page.close();
  }

  const page = await context.newPage();
  await page.goto(base + '/src/ui/search/search.html');
  await page.fill('#q', 'retention');
  await page.waitForSelector('article');
  const pressed = () => page.$$eval('[data-sort]', (nodes) => nodes.map((n) => n.getAttribute('aria-pressed')));
  check('the active sort is said, not only shown', JSON.stringify(await pressed()) === '["true","false"]', await pressed());
  await page.click('[data-sort="recent"]');
  check('and follows the choice', JSON.stringify(await pressed()) === '["false","true"]', await pressed());
  await context.close();
}

// --- forced colours ---------------------------------------------------------
{
  const { context, base } = await launch({ forcedColors: 'active' });
  const page = await context.newPage();
  await page.goto(base + '/src/ui/search/search.html');
  await page.fill('#q', 'retention');
  await page.waitForFunction(() => document.querySelectorAll('article').length > 1);
  const colours = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('article')];
    const selected = rows.find((r) => r.classList.contains('selected'));
    const other = rows.find((r) => r !== selected);
    const on = document.querySelector('.sort button.on');
    const off = document.querySelector('.sort button:not(.on)');
    return {
      forced: matchMedia('(forced-colors: active)').matches,
      selected: getComputedStyle(selected).borderLeftColor,
      other: getComputedStyle(other).borderLeftColor,
      onBorder: getComputedStyle(on).borderTopColor,
      offBorder: getComputedStyle(off).borderTopColor,
    };
  });
  check('forced colours are on for this check', colours.forced, JSON.stringify(colours));
  check('the selected result is marked differently from the rest',
    colours.selected !== colours.other, JSON.stringify(colours));
  check('the active sort is marked differently from the other',
    colours.onBorder !== colours.offBorder, JSON.stringify(colours));

  const meter = await context.newPage();
  await meter.goto(base + '/src/ui/options/options.html');
  await meter.waitForTimeout(600);
  const bar = await meter.evaluate(() => {
    const track = document.querySelector('.bar');
    const fill = document.querySelector('.bar span');
    return { edge: getComputedStyle(track).borderTopWidth, fill: getComputedStyle(fill).backgroundColor,
      track: getComputedStyle(track).backgroundColor };
  });
  check('the storage meter has an edge and a fill that are not the page colour',
    parseFloat(bar.edge) > 0 && bar.fill !== bar.track, JSON.stringify(bar));
  await context.close();
}

// --- reflow -----------------------------------------------------------------
{
  const { context, base } = await launch();
  const pages = [
    ['search', '/src/ui/search/search.html', async (p) => { await p.fill('#q', 'retention'); await p.waitForTimeout(700); }],
    ['options', '/src/ui/options/options.html'],
    ...[0, 1, 2, 3, 4, 5].map((step) => ['setup step ' + step, '/src/ui/setup/setup.html', async (p) => {
      await p.evaluate((n) => { for (const el of document.querySelectorAll('section[data-step]')) el.hidden = el.dataset.step !== String(n); }, step);
    }]),
  ];
  for (const [name, url, prepare] of pages) {
    for (const width of [320, 256]) {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 600 });
      await page.goto(base + url);
      await page.waitForTimeout(400);
      if (prepare) await prepare(page);
      await page.waitForTimeout(200);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(name + ' fits in ' + width + 'px without scrolling sideways', overflow <= 0, overflow + 'px too wide');
      await page.close();
    }
  }
  await context.close();
}

const failed = checks.filter((c) => !c.ok).length;
console.log('\n' + (checks.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
