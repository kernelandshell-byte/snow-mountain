// The fallback path for jump to passage. A text fragment only fires on a
// fresh document load, so a tab already sitting on the page, and a page whose
// content arrives after load, both need this instead.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrantedExtension } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The routing half of this test injects into a real page, which needs host
// permissions the shipped manifest deliberately does not ask for at install.
const granted = await buildGrantedExtension(root);

const TARGET = 'Retro fatigue sets in when the same problems are raised every fortnight.';
const filler = Array.from(
  { length: 40 },
  (_, i) => '<p>Filler paragraph ' + (i + 1) + ', here only to make the document tall enough that scrolling is unambiguous.</p>'
).join('\n');

const articlePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title>
<style>body{font:16px/1.6 system-ui;max-width:640px;margin:0 auto;padding:24px}</style></head>
<body><h1>Fixture</h1>${filler}<p id="target">${TARGET}</p>${filler}</body></html>`;

// Same page, but the passage is inserted after load, which is what a text
// fragment cannot wait for.
const latePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Late</title>
<style>body{font:16px/1.6 system-ui;max-width:640px;margin:0 auto;padding:24px}</style></head>
<body><h1>Late</h1>${filler}<div id="slot"></div>${filler}
<script>setTimeout(function(){var p=document.createElement('p');p.id='target';p.textContent=${JSON.stringify(TARGET)};document.getElementById('slot').appendChild(p);},600);</script>
</body></html>`;

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 900, height: 700 },
  args: [
    '--disable-extensions-except=' + granted.dir,
    '--load-extension=' + granted.dir,
    '--no-sandbox',
  ],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

await context.route('https://fixture.example/**', (route) => {
  route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: route.request().url().includes('late') ? latePage : articlePage,
  });
});

const checks = [];
const errors = [];
const check = (name, condition, detail) =>
  checks.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });

async function highlightOn(url, quote, options = {}) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(url);
  if (options.waitFor) await page.waitForTimeout(options.waitFor);
  await page.evaluate(
    ({ text, only }) => {
      window.__snowMountainQuote = text;
      window.__snowMountainOnlyIfUnscrolled = only;
    },
    { text: quote, only: options.onlyIfUnscrolled === true }
  );
  await page.addScriptTag({ path: path.join(root, 'src/content/highlight.js') });
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    highlighted: !!(window.CSS && CSS.highlights && CSS.highlights.get('snow-mountain')),
    targetTop: document.getElementById('target')
      ? Math.round(document.getElementById('target').getBoundingClientRect().top + window.scrollY)
      : null,
    unchanged: !document.querySelector('#target span'),
  }));
  return { page, state };
}

// --- the passage is exactly as it was stored ------------------------------
let { page, state } = await highlightOn('https://fixture.example/article', TARGET);
check('it scrolls to the passage', state.scrollY > 0, state.scrollY);
check('and lands near it, not somewhere else',
  Math.abs(state.targetTop - state.scrollY) < 600, 'target at ' + state.targetTop + ', scrolled to ' + state.scrollY);
check('the passage is painted', state.highlighted, 'no highlight');
check('the page itself is not rewritten', state.unchanged, 'the DOM was modified');
await page.close();

// --- the passage was edited since it was captured -------------------------
({ page, state } = await highlightOn(
  'https://fixture.example/article',
  'Retro fatigue sets in when the same problems are raised every single week and nothing at all changes.'
));
check('an edited passage still gets found by its opening', state.scrollY > 0, state.scrollY);
await page.close();

// --- the passage is gone --------------------------------------------------
({ page, state } = await highlightOn('https://fixture.example/article', 'A sentence about kangaroos that was never on this page.'));
check('a passage that is gone leaves the page alone', state.scrollY === 0, state.scrollY);
check('and paints nothing', !state.highlighted, 'highlighted something');
await page.close();

// --- content that arrives after load --------------------------------------
({ page, state } = await highlightOn('https://fixture.example/late', TARGET, { waitFor: 900 }));
check('late rendered content is still found', state.scrollY > 0, state.scrollY);
await page.close();

// --- the guard that stops it fighting a text fragment ---------------------
({ page, state } = await highlightOn('https://fixture.example/article', TARGET, {
  onlyIfUnscrolled: true,
}));
check('as a second attempt it runs when the page did not scroll', state.scrollY > 0, state.scrollY);
await page.close();

const scrolled = await context.newPage();
await scrolled.goto('https://fixture.example/article');
await scrolled.evaluate(() => window.scrollTo(0, 400));
await scrolled.evaluate(() => {
  window.__snowMountainQuote = 'Filler paragraph 39, here only to make the document tall enough that scrolling is unambiguous.';
  window.__snowMountainOnlyIfUnscrolled = true;
});
await scrolled.addScriptTag({ path: path.join(root, 'src/content/highlight.js') });
await scrolled.waitForTimeout(300);
const afterGuard = await scrolled.evaluate(() => Math.round(window.scrollY));
check('and stands down when the fragment already scrolled', afterGuard === 400, afterGuard);
await scrolled.close();

// --- routing through the worker -------------------------------------------
const openTab = await context.newPage();
await openTab.goto('https://fixture.example/article');
await openTab.evaluate(() => window.scrollTo(0, 0));

const driver = await context.newPage();
await driver.goto('chrome-extension://' + extensionId + '/src/ui/search/search.html');

const existingResult = await driver.evaluate(async (quote) => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({
    type: MSG.OPEN_RESULT,
    payload: { url: 'https://fixture.example/article', quote },
  });
}, TARGET);
check('a page already open is reused rather than opened twice',
  existingResult.opened === 'existing', JSON.stringify(existingResult));
check('and the highlight script is injected into it',
  existingResult.highlighted === true, JSON.stringify(existingResult));

await openTab.waitForTimeout(400);
const reusedScroll = await openTab.evaluate(() => Math.round(window.scrollY));
check('the tab that was already open scrolls to the passage', reusedScroll > 0, reusedScroll);

const before = context.pages().length;
const newResult = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({
    type: MSG.OPEN_RESULT,
    payload: { url: 'https://fixture.example/second', quote: 'Filler paragraph 12, here only to make the document tall enough' },
  });
});
check('a page that is not open gets a new tab', newResult.opened === 'new', JSON.stringify(newResult));
check('and that is one more tab', context.pages().length === before + 1, context.pages().length);

await context.close();
await granted.cleanup();

let failed = 0;
for (const result of checks) {
  if (result.ok) console.log('  ok   ' + result.name);
  else { failed += 1; console.log('  FAIL ' + result.name + '\n       ' + result.detail); }
}
for (const error of errors) console.log('  page error: ' + error);
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed || errors.length ? 1 : 0);
