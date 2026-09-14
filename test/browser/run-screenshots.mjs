// Every surface, both themes, at two widths, in one run.
//
// Not a test: nothing here can fail. It exists because a visual system is the
// one thing a test suite cannot check, and because looking at all eight
// screens side by side is how you notice that three of them are using three
// different greys.
//
//   node test/browser/run-screenshots.mjs [outputDirectory]

import { chromium } from 'playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = process.argv[2] || path.join(root, 'screenshots');
await mkdir(out, { recursive: true });
const ctx = await chromium.launchPersistentContext('', {
  headless: false, viewport: { width: 1000, height: 900 },
  args: ['--disable-extensions-except='+root, '--load-extension='+root, '--no-sandbox'],
});
let [w] = ctx.serviceWorkers(); if (!w) w = await ctx.waitForEvent('serviceworker');
const id = new URL(w.url()).host;

const seed = await ctx.newPage();
await seed.goto('chrome-extension://'+id+'/src/ui/options/options.html');
await seed.evaluate(async () => {
  const { CORPUS } = await import('/test/fixtures/corpus.js');
  const { MSG } = await import('/src/shared/messages.js');
  await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: { setupComplete: true, mode: 'broad' } });
  for (const doc of CORPUS) {
    await chrome.runtime.sendMessage({ type: MSG.PAGE_CONTENT, payload: {
      url: doc.url, title: doc.title, text: doc.text,
      capturedAt: Date.now() - Math.floor(Math.random()*40)*86400000 } });
  }

});
await seed.close();

async function shot(name, url, opts = {}) {
  for (const scheme of ['light', 'dark']) {
    const p = await ctx.newPage();
    await p.emulateMedia({ colorScheme: scheme });
    if (opts.width) await p.setViewportSize({ width: opts.width, height: opts.height || 900 });
    await p.goto(url);
    if (opts.before) await opts.before(p);
    // Park the pointer somewhere harmless, so a stray :hover does not turn up
    // in the picture and get mistaken for a design decision.
    await p.mouse.move(2, 2);
    await p.waitForTimeout(900);
    await p.screenshot({ path: `${out}/${name}-${scheme}.png`, fullPage: !!opts.full });
    await p.close();
  }
}

const base = 'chrome-extension://'+id;
await shot('search-empty', base+'/src/ui/search/search.html');
await shot('search-results', base+'/src/ui/search/search.html', {
  before: async (p) => { await p.fill('#q', 'retention'); await p.waitForTimeout(800); await p.keyboard.press('ArrowDown'); },
});
await shot('search-narrow', base+'/src/ui/search/search.html', {
  width: 380, before: async (p) => { await p.fill('#q', 'cohort chart'); await p.waitForTimeout(700); },
});
await shot('popup', base+'/src/ui/popup/popup.html', { width: 340, height: 620 });
await shot('options', base+'/src/ui/options/options.html', { full: true });
await shot('setup', base+'/src/ui/setup/setup.html', { full: true });
await shot('setup-modes', base+'/src/ui/setup/setup.html', {
  full: true, before: async (p) => { await p.click('section[data-step="0"] [data-next]'); },
});
await ctx.close();
console.log('wrote 14 screenshots to ' + out);
