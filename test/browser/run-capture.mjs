// The full capture path, which nothing else exercises: a real page, the
// observer measuring real dwell and scrolling, the worker deciding, the
// extractor injected into the tab, and a record landing in the index.
//
// Slow by nature. A page has to hold attention for several seconds before it
// counts as read, and that wait is the thing being tested.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrantedExtension } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const granted = await buildGrantedExtension(root);

const ARTICLE = 'Retro fatigue sets in when the same problems are raised every fortnight and nothing changes.';
const body = Array.from({ length: 30 }, (_, i) =>
  '<p>Paragraph ' + (i + 1) + ' of an article long enough that reading it involves scrolling, which is what the observer is watching for.</p>'
).join('\n');

const page = (extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Why teams stop running retrospectives</title></head>
<body>
  <nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
  ${extra}
  <article><h1>Why teams stop running retrospectives</h1><p>${ARTICLE}</p>${body}</article>
  <footer>Copyright and a modern slavery statement nobody reads.</footer>
</body></html>`;

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
  const login = url.includes('login') ? '<form><input type="password" name="p" /></form>' : '';
  route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page(login) });
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

await ask('SETTINGS_SET', {
  setupComplete: true,
  mode: 'broad',
  presets: { banking: true },
  customRules: ['excluded.example'],
});

// Reading a page: open it, look at it, scroll it, keep looking.
async function read(url, seconds = 14) {
  const tab = await context.newPage();
  await tab.goto(url);
  await tab.bringToFront();
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    await tab.mouse.wheel(0, 400);
    await tab.waitForTimeout(1000);
  }
  return tab;
}

const tab = await read('https://reader.example/retro-fatigue');
await driver.bringToFront();
await driver.waitForTimeout(1500);

const status = await ask('PAGE_STATUS', { url: 'https://reader.example/retro-fatigue' });
check('a page that was actually read gets kept', status.kept !== null, JSON.stringify(status));

const found = await ask('SEARCH', { query: 'retro fatigue fortnight' });
check('and is findable straight away', found.results.length === 1, JSON.stringify(found.results.map((r) => r.url)));
check('by the sentence it was read for',
  found.results[0] && /Retro fatigue/.test(found.results[0].snippet.text),
  found.results[0] && found.results[0].snippet.text);

const stored = await driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const recent = await chrome.runtime.sendMessage({ type: MSG.RECENT, payload: { limit: 1 } });
  return recent[0];
});
check('the stored text is the article, not the chrome around it',
  stored.text.includes(ARTICLE) && !/modern slavery/i.test(stored.text) && !/Pricing/.test(stored.text),
  stored.text.slice(0, 160));
check('the title came from the page', /Why teams stop/.test(stored.title), stored.title);
await tab.close();

// A page with a password field on it is never captured, in any mode.
const loginTab = await read('https://reader.example/login', 14);
await driver.bringToFront();
await driver.waitForTimeout(1200);
const loginStatus = await ask('PAGE_STATUS', { url: 'https://reader.example/login' });
check('a page with a password field is not captured', loginStatus.kept === null, JSON.stringify(loginStatus));
await loginTab.close();

// An excluded domain is never captured either.
const excludedTab = await read('https://excluded.example/article', 14);
await driver.bringToFront();
await driver.waitForTimeout(1200);
const excludedStatus = await ask('PAGE_STATUS', { url: 'https://excluded.example/article' });
check('an excluded site is not captured', excludedStatus.kept === null, JSON.stringify(excludedStatus));
check('and the reason says which rule stopped it', /excluded/.test(excludedStatus.reason), excludedStatus.reason);
await excludedTab.close();

// A glance is not reading.
const glance = await context.newPage();
await glance.goto('https://reader.example/glanced-at');
await glance.bringToFront();
await glance.waitForTimeout(3000);
await glance.close();
await driver.bringToFront();
await driver.waitForTimeout(1000);
const glanceStatus = await ask('PAGE_STATUS', { url: 'https://reader.example/glanced-at' });
check('a page glanced at for three seconds is not kept', glanceStatus.kept === null, JSON.stringify(glanceStatus));

const finalStats = await ask('STATS');
check('exactly one page was kept out of four visited', finalStats.docCount === 1, finalStats.docCount);

await context.close();
await granted.cleanup();

let failed = 0;
for (const result of checks) {
  if (result.ok) console.log('  ok   ' + result.name);
  else { failed += 1; console.log('  FAIL ' + result.name + '\n       ' + result.detail); }
}
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
