// One realistic session, start to finish, in the order a person would do it.
// Every other suite tests a part; this one checks the parts still fit
// together, and that nothing along the way is confusing or broken.

import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrantedExtension } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const granted = await buildGrantedExtension(root);

const ARTICLES = {
  '/retro-fatigue': {
    title: 'Why teams stop running retrospectives',
    body: 'Retro fatigue sets in when the same problems are raised every fortnight and nothing changes. What kills a retrospective is the absence of a visible loop between what gets raised and what gets done.',
  },
  '/cohort-chart': {
    title: 'Reading a churn cohort chart',
    body: 'A cohort chart puts each signup month on its own row and follows it across time. Healthy products show a steep drop and then a flattening, and the height of that flat section is what matters.',
  },
  '/content-briefs': {
    title: 'Briefs that survive the writer',
    body: 'A brief listing only keywords produces an article assembled from keywords. The ones that work say who the reader is, what they already believe, and what the piece may leave out.',
  },
};

// A real server rather than request interception. A tab the extension opens
// starts loading the moment it is created, which can outrun Playwright
// attaching its network interception to that new target.
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const article = ARTICLES[pathname] || { title: 'Something else', body: 'A page of no particular interest.' };
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + article.title + '</title></head><body>' +
      '<nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>' +
      // The passage that matters sits below the fold on purpose: landing on
      // a sentence that was already visible would prove nothing.
      '<article><h1>' + article.title + '</h1>' +
      Array.from({ length: 25 }, (_, i) => '<p>Opening paragraph ' + (i + 1) + ' that exists so the article is long enough to scroll through properly.</p>').join('') +
      '<p>' + article.body + '</p>' +
      Array.from({ length: 10 }, (_, i) => '<p>Closing paragraph ' + (i + 1) + ' after the part that matters.</p>').join('') +
      '</article><footer>Copyright and legal boilerplate.</footer></body></html>'
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const site = 'http://127.0.0.1:' + server.address().port;

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 1000, height: 800 },
  args: ['--disable-extensions-except=' + granted.dir, '--load-extension=' + granted.dir, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

const checks = [];
const errors = [];
const check = (name, condition, detail) =>
  checks.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });
const watch = (p) => {
  p.on('pageerror', (error) => errors.push(String(error)));
  p.on('console', (message) => {
    if (message.type() === 'error') errors.push('console: ' + message.text());
  });
  return p;
};

// 1. Setup, the way it opens on install.
const setup = watch(await context.newPage());
await setup.addInitScript(() => {
  chrome.permissions.request = () => Promise.resolve(true);
});
await setup.goto('chrome-extension://' + extensionId + '/src/ui/setup/setup.html');
await setup.click('[data-next]');
await setup.click('#chooseMode');
await setup.waitForTimeout(300);
await setup.click('section[data-step="2"] [data-next]');
await setup.click('#finish');
await setup.waitForTimeout(500);
check('setup finishes', /Pages you read from now on/.test(await setup.textContent('#doneNote')), await setup.textContent('#doneNote'));
await setup.close();

// 2. Read three articles properly.
async function read(pathname) {
  const tab = watch(await context.newPage());
  await tab.goto(site + pathname);
  await tab.bringToFront();
  for (let i = 0; i < 13; i++) {
    await tab.mouse.wheel(0, 400);
    await tab.waitForTimeout(1000);
  }
  return tab;
}

const first = await read('/retro-fatigue');
await first.close();
const second = await read('/cohort-chart');
await second.close();
const third = await read('/content-briefs');

// 3. While still on the third article, check the popup says something true.
const popup = watch(await context.newPage());
await popup.addInitScript((where) => {
  chrome.tabs.query = () => Promise.resolve([{ id: 1, url: where + '/content-briefs' }]);
}, site);
await popup.goto('chrome-extension://' + extensionId + '/src/ui/popup/popup.html');
await popup.waitForFunction(() => !/Checking/.test(document.getElementById('pageStatus').textContent));
check('the popup knows the page you are on was kept',
  /Kept, last read today/.test(await popup.textContent('#pageStatus')), await popup.textContent('#pageStatus'));
check('and reports the collection so far',
  /3 pages kept/.test(await popup.textContent('#budgetText')), await popup.textContent('#budgetText'));
await popup.close();
await third.close();

// 4. Search for something half remembered, from the wrong angle.
const search = watch(await context.newPage());
await search.goto('chrome-extension://' + extensionId + '/src/ui/search/search.html');
await search.fill('#q', 'problems raised nothing changes');
await search.waitForSelector('article', { timeout: 5000 });
check('a half remembered phrase finds the right article',
  /retrospectives/.test(await search.textContent('article h2')), await search.textContent('article h2'));
check('the snippet shows why it matched',
  (await search.$$eval('article:first-child mark', (n) => n.length)) > 0, 'no highlights');

// 5. Open the result and land on the passage.
const opened = context.waitForEvent('page');
await search.click('article h2 a');
const resultTab = watch(await opened);
await resultTab.waitForLoadState('load');
await resultTab.waitForTimeout(2000);
const landed = await resultTab.evaluate(() => ({ y: Math.round(window.scrollY), href: location.href }));
check('opening it scrolls to the passage rather than the top', landed.y > 0, JSON.stringify(landed));
const highlighted = await resultTab.evaluate(() =>
  !!(window.CSS && CSS.highlights && CSS.highlights.get('snow-mountain'))
);
// Either route is fine here: the fragment scrolls without leaving a trace we
// can read, and the fallback paints one. What matters is that it landed.
check('and did so by one route or the other', landed.y > 0 || highlighted, JSON.stringify({ landed, highlighted }));
await resultTab.close();

// 6. Pin it, then check a filter narrows things.
await search.bringToFront();
await search.click('.pin');
await search.waitForTimeout(300);
check('pinning holds', (await search.getAttribute('.pin', 'aria-pressed')) === 'true', 'pin did not stick');

await search.fill('#q', 'the');
await search.waitForTimeout(600);
const siteCount = await search.$$eval('#site option', (n) => n.length);
check('the site filter offers the sites that matched', siteCount >= 2, siteCount);

// 7. Settings: tighten the budget, sweep, and check the log explains itself.
const options = watch(await context.newPage());
await options.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
await options.waitForFunction(() => document.getElementById('usage').textContent.length > 0);
check('settings reports the collection in pages and bytes',
  /3 pages/.test(await options.textContent('#usage')), await options.textContent('#usage'));

await options.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: { sizeCapBytes: 2000 } });
});
await options.click('#sweep');
await options.waitForTimeout(800);
const logText = await options.textContent('#log');
check('the sweep is explained in the log', /over your size limit/.test(logText), logText);

const survived = await options.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const recent = await chrome.runtime.sendMessage({ type: MSG.RECENT, payload: { limit: 20 } });
  return recent.map((p) => ({ url: p.url, pinned: p.pinned }));
});
check('the pinned article survived the squeeze',
  survived.some((p) => /retro-fatigue/.test(p.url) && p.pinned === 1), JSON.stringify(survived));

// 8. Export, so there is something to walk away with.
const download = await Promise.all([
  options.waitForEvent('download', { timeout: 10000 }),
  options.click('#export'),
]).then(([d]) => d);
check('the export downloads', !!(await download.path()), 'no file');

await context.close();
await granted.cleanup();
server.close();

let failed = 0;
for (const result of checks) {
  if (result.ok) console.log('  ok   ' + result.name);
  else { failed += 1; console.log('  FAIL ' + result.name + '\n       ' + result.detail); }
}
for (const error of errors) console.log('  page error: ' + error);
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed || errors.length ? 1 : 0);
