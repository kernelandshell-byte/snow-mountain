// The PDF capture path end to end: a real PDF served over http, the native
// Chrome viewer, the content script fetching its own tab's bytes, the
// offscreen document running vendored pdf.js, and a record landing in the
// index -- through the real extension code.

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrantedExtension } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const granted = await buildGrantedExtension(root);

const article = await readFile(path.join(root, 'test/fixtures/pdf/article.pdf'));
const blank = await readFile(path.join(root, 'test/fixtures/pdf/blank.pdf'));
const manyPages = await readFile(path.join(root, 'test/fixtures/pdf/many-pages.pdf'));

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 900, height: 700 },
  args: ['--disable-extensions-except=' + granted.dir, '--load-extension=' + granted.dir, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

await context.route('**/*', (route) => {
  const url = route.request().url();
  if (!/^https?:/.test(url)) return route.continue();
  const p = new URL(url).pathname;
  if (p === '/article.pdf') {
    return route.fulfill({ status: 200, contentType: 'application/pdf', body: article });
  }
  if (p === '/blank.pdf') {
    return route.fulfill({ status: 200, contentType: 'application/pdf', body: blank });
  }
  if (p === '/many-pages.pdf') {
    return route.fulfill({ status: 200, contentType: 'application/pdf', body: manyPages });
  }
  if (p === '/login-wall.pdf') {
    // A server claiming application/pdf while actually serving a login page,
    // the paywall/login-gate scenario THREAT-MODEL.md's fetch exception
    // names. The magic-header check in content/pdf-fetch.js has to catch
    // this itself, since the browser will happily render Chrome's native
    // "can't open this file" state or nothing useful either way.
    return route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: '<!doctype html><html><body><h1>Please log in</h1></body></html>',
    });
  }
  return route.continue();
});

const checks = [];
const check = (name, condition, detail) =>
  checks.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });

const driver = await context.newPage();
await driver.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
const ask = (type, payload) =>
  driver.evaluate(
    async ({ t, p }) => {
      const { MSG } = await import('/src/shared/messages.js');
      return chrome.runtime.sendMessage({ type: MSG[t], payload: p });
    },
    { t: type, p: payload }
  );

await ask('SETTINGS_SET', { setupComplete: true, mode: 'broad' });

// Reading a PDF the way a person actually would: open it, dwell on it. There
// is deliberately no scrolling here -- the whole point is that a PDF tab has
// no scroll signal to give, and this proves dwell alone is enough.
async function open(url, seconds) {
  const tab = await context.newPage();
  await tab.goto(url);
  await tab.bringToFront();
  await tab.waitForTimeout(seconds * 1000);
  return tab;
}

const articleTab = await open('https://reader.example/article.pdf', 12);
await driver.bringToFront();
await driver.waitForTimeout(2000);

const status = await ask('PAGE_STATUS', { url: 'https://reader.example/article.pdf' });
check('a pdf read for twelve seconds, with no scrolling at all, is kept', status.kept !== null, JSON.stringify(status));

const found = await ask('SEARCH', { query: 'retro fatigue fortnight' });
check('and is findable by its actual text', found.results.length === 1, JSON.stringify(found.results.map((r) => r.url)));

const stored = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const recent = await chrome.runtime.sendMessage({ type: MSG.RECENT, payload: { limit: 1 } });
  return recent[0];
});
check('the extracted text is the pdf\'s real content',
  stored.text.includes('relitigating it'), stored.text.slice(0, 200));
check('the title came from the pdf, not the url', /retrospectives/i.test(stored.title), stored.title);
await articleTab.close();

// A scanned / image-only PDF: pdf.js succeeds and returns empty text, which
// is a different failure than the fetch or the parse failing outright.
const blankTab = await open('https://reader.example/blank.pdf', 12);
await driver.bringToFront();
await driver.waitForTimeout(2000);
const blankStatus = await ask('PAGE_STATUS', { url: 'https://reader.example/blank.pdf' });
check('a pdf with no text layer at all is not kept', blankStatus.kept === null, JSON.stringify(blankStatus));
await blankTab.close();

// A URL that claims to be a PDF but serves an HTML login/paywall page. The
// one thing standing between this and indexing a login page as if it were
// the article: content/pdf-fetch.js's magic-header check.
const loginWallTab = await open('https://reader.example/login-wall.pdf', 12);
await driver.bringToFront();
await driver.waitForTimeout(2000);
const loginWallStatus = await ask('PAGE_STATUS', { url: 'https://reader.example/login-wall.pdf' });
check('a login page served as application/pdf is not indexed as one',
  loginWallStatus.kept === null, JSON.stringify(loginWallStatus));
await loginWallTab.close();

// A PDF with far more pages than MAX_TEXT_BYTES could ever hold text for.
// onPageContent truncates any text to that cap regardless, but the
// offscreen document has its own early exit once it has extracted enough,
// so a document like this does not pay full pdf.js extraction cost for
// pages whose text would only be thrown away. This is the only committed
// fixture big enough to actually exercise that loop (measured on a 12,000
// page, 14.5MB file: ~47.5s uncapped, ~9s with the early exit).
const manyPagesTab = await open('https://reader.example/many-pages.pdf', 12);
await driver.bringToFront();
await driver.waitForTimeout(2000);
const manyPagesStatus = await ask('PAGE_STATUS', { url: 'https://reader.example/many-pages.pdf' });
check('a pdf with far more pages than the text cap holds is still kept',
  manyPagesStatus.kept !== null, JSON.stringify(manyPagesStatus));
const manyPagesStored = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const { MAX_TEXT_BYTES } = await import('/src/shared/constants.js');
  const recent = await chrome.runtime.sendMessage({ type: MSG.RECENT, payload: { limit: 1 } });
  return { text: recent[0].text, cap: MAX_TEXT_BYTES };
});
check('and its stored text is truncated to the cap, not the whole document',
  manyPagesStored.text.length === manyPagesStored.cap,
  'stored ' + manyPagesStored.text.length + ' chars, cap is ' + manyPagesStored.cap);
await manyPagesTab.close();

// Explicit "keep this page now" from the popup, on a PDF, without waiting
// for any dwell at all -- exercises injectExtractor's own content-type probe
// rather than the isPdf flag observer.js already reported.
const nowTab = await context.newPage();
await nowTab.goto('https://reader.example/article.pdf');
await driver.bringToFront();
const tabs = await driver.evaluate(() => chrome.tabs.query({}));
const nowTabId = tabs.find((t) => t.url && t.url.includes('article.pdf'))?.id;
const captureNowResult = await ask('CAPTURE_NOW', { tabId: nowTabId, url: 'https://reader.example/article.pdf' });
check('capture now works on a pdf tab immediately, no dwell required',
  captureNowResult.ok === true, JSON.stringify(captureNowResult));
await driver.waitForTimeout(1500);
const nowStatus = await ask('PAGE_STATUS', { url: 'https://reader.example/article.pdf' });
check('and the page shows up kept', nowStatus.kept !== null, JSON.stringify(nowStatus));
await nowTab.close();

await context.close();
await granted.cleanup();

let failed = 0;
for (const result of checks) {
  if (result.ok) console.log('  ok   ' + result.name);
  else { failed += 1; console.log('  FAIL ' + result.name + '\n       ' + result.detail); }
}
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
