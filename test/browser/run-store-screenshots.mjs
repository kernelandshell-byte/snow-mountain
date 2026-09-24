// The screenshots for the Chrome Web Store listing, at the 1280x800 the
// store asks for. Not a test.
//
//   node test/browser/run-store-screenshots.mjs [outputDirectory]

import { chromium } from 'playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = process.argv[2] || path.join(root, 'screenshots', 'store');
await mkdir(out, { recursive: true });

const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});
let [worker] = ctx.serviceWorkers();
if (!worker) worker = await ctx.waitForEvent('serviceworker');
const base = 'chrome-extension://' + new URL(worker.url()).host;

const seed = await ctx.newPage();
await seed.goto(base + '/src/ui/options/options.html');
await seed.evaluate(async () => {
  const { CORPUS } = await import('/test/fixtures/corpus.js');
  const { MSG } = await import('/src/shared/messages.js');
  await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: { setupComplete: true, mode: 'broad', stemLanguages: ['en', 'es'] } });
  let age = 0;
  for (const doc of CORPUS) {
    await chrome.runtime.sendMessage({
      type: MSG.PAGE_CONTENT,
      payload: { url: doc.url, title: doc.title, text: doc.text, capturedAt: Date.now() - age++ * 3 * 86400000 },
    });
  }
});
await seed.close();

async function shot(name, url, before) {
  const page = await ctx.newPage();
  await page.goto(base + url);
  if (before) await before(page);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(out, name + '.png') });
  await page.close();
}

await shot('1-search', '/src/ui/search/search.html', async (p) => {
  await p.fill('#q', 'retention');
  await p.waitForTimeout(700);
});
await shot('2-setup', '/src/ui/setup/setup.html');
await shot('3-languages', '/src/ui/setup/setup.html', async (p) => {
  await p.evaluate(() => {
    for (const section of document.querySelectorAll('section[data-step]')) section.hidden = section.dataset.step !== '4';
    document.querySelectorAll('.dots li').forEach((dot) => dot.classList.add('on'));
  });
});
await shot('4-settings', '/src/ui/options/options.html');

// The 1400x560 promo tile: the pitch on the left, the search page on the
// right, cropped as if the window ran off the edge of the tile.
const { readFile } = await import('node:fs/promises');
const inline = async (file) => 'data:image/png;base64,' + (await readFile(file)).toString('base64');
const searchShot = await inline(path.join(out, '1-search.png'));
const icon = await inline(path.join(root, 'icons', 'icon-128.png'));
const promo = await ctx.newPage();
await promo.setViewportSize({ width: 1400, height: 560 });
await promo.setContent(`<!doctype html><style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1400px; height: 560px; overflow: hidden; position: relative;
    font-family: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background:
      radial-gradient(700px 480px at 12% 110%, rgb(90 44 245 / .55), transparent 70%),
      radial-gradient(600px 400px at 95% -20%, rgb(90 44 245 / .35), transparent 70%),
      #0b0b0c;
    color: #f4f4f2; -webkit-font-smoothing: antialiased;
  }
  .copy { position: absolute; left: 88px; top: 96px; width: 560px; }
  .brand { display: flex; align-items: center; gap: 14px; font-weight: 850; font-size: 30px; letter-spacing: -0.04em; }
  .brand img { width: 52px; height: 52px; }
  .eyebrow {
    margin-top: 44px; font: 600 13px/1 ui-monospace, "DejaVu Sans Mono", monospace;
    letter-spacing: .14em; text-transform: uppercase; color: #a48bff;
  }
  h1 { margin-top: 16px; font-size: 66px; font-weight: 800; line-height: 1.02; letter-spacing: -0.045em; }
  mark { background: #e3ff4f; color: #0b0b0c; padding: 0 10px; border-radius: 8px; }
  p { margin-top: 22px; font-size: 19px; line-height: 1.55; color: #b4b4bb; max-width: 470px; }
  .window {
    position: absolute; left: 700px; top: 70px; width: 860px; height: 620px;
    border-radius: 18px; overflow: hidden; background: #fff;
    border: 1px solid rgb(255 255 255 / .12);
    box-shadow: 0 40px 80px -20px rgb(0 0 0 / .7), 0 0 0 8px rgb(255 255 255 / .04);
  }
  .chrome { height: 34px; background: #f5f5f3; display: flex; gap: 8px; align-items: center; padding: 0 14px; border-bottom: 1px solid #e7e7e4; }
  .chrome i { width: 11px; height: 11px; border-radius: 50%; background: #d8d8d4; }
  .window img { display: block; margin-left: -240px; width: 1280px; }
</style>
<div class="copy">
  <div class="brand"><img src="${icon}" alt="">TextMemory</div>
  <div class="eyebrow">Full-text search · Stays on your computer</div>
  <h1>Find anything you've <mark>read</mark>.</h1>
  <p>Search the full text of every page you've read, by any phrase you remember. Everything stays on your computer.</p>
</div>
<div class="window"><div class="chrome"><i></i><i></i><i></i></div><img src="${searchShot}" alt=""></div>`);
await promo.waitForTimeout(300);
await promo.screenshot({ path: path.join(out, '0-promo.png') });
await promo.close();

await ctx.close();
console.log('wrote 5 images to ' + out);
