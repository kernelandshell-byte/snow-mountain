// Walks the setup flow the way a person does, including the branch where
// Chrome refuses access. The permission prompt itself cannot be clicked by
// automation, so chrome.permissions.request is stubbed: what is being tested
// is that the flow asks at the right moment and reacts correctly to both
// answers, not that Chrome's own dialog works.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 900, height: 900 },
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;
const setupUrl = 'chrome-extension://' + extensionId + '/src/ui/setup/setup.html';

const checks = [];
const check = (name, condition, detail) =>
  checks.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });

const errors = [];

async function openSetup(permissionAnswer) {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push('console: ' + message.text());
  });
  await page.addInitScript((answer) => {
    window.__requested = [];
    const original = chrome.permissions.request.bind(chrome.permissions);
    chrome.permissions.request = (options) => {
      window.__requested.push(options);
      return Promise.resolve(answer);
    };
    window.__originalRequest = original;
  }, permissionAnswer);
  await page.goto(setupUrl);
  return page;
}

const visibleStep = (page) =>
  page.$eval('section[data-step]:not([hidden])', (el) => Number(el.dataset.step));

// --- the path where access is granted ------------------------------------
let page = await openSetup(true);
check('setup starts at the explanation', (await visibleStep(page)) === 0, await visibleStep(page));
check('it says where the data goes before asking for anything',
  (await page.textContent('section[data-step="0"]')).includes('No account'), 'missing');

await page.click('[data-next]');
check('the second screen is the capture choice', (await visibleStep(page)) === 1, await visibleStep(page));

await page.click('#chooseMode');
await page.waitForTimeout(200);
const requested = await page.evaluate(() => window.__requested);
check('broad mode asks for host access, at the moment it is explained',
  requested.length === 1 && requested[0].origins[0] === '*://*/*', JSON.stringify(requested));
check('granting access moves on to exclusions', (await visibleStep(page)) === 2, await visibleStep(page));

const presetCount = await page.$$eval('[data-preset]', (nodes) => nodes.length);
const allChecked = await page.$$eval('[data-preset]', (nodes) => nodes.every((n) => n.checked));
check('exclusion bundles are offered', presetCount === 6, presetCount);
check('and are on by default', allChecked, 'some bundle was off');

await page.uncheck('[data-preset="adult"]');
await page.click('section[data-step="2"] [data-next]');
check('the last screen is the budget', (await visibleStep(page)) === 3, await visibleStep(page));

const capacity = await page.textContent('#capacity');
check('the budget is expressed in pages, not megabytes', /Roughly [\d,]+ pages/.test(capacity), capacity);

await page.selectOption('#size', '1000');
const biggerCapacity = await page.textContent('#capacity');
check('a bigger cap means more pages', biggerCapacity !== capacity, biggerCapacity);

await page.selectOption('#months', '24');
await page.click('#finish');
await page.waitForTimeout(400);
check('setup ends on a confirmation', (await visibleStep(page)) === 4, await visibleStep(page));

const saved = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
});
check('the choices were saved', saved.setupComplete === true && saved.mode === 'broad', JSON.stringify(saved));
check('the excluded bundle stayed off', saved.presets.adult === false, JSON.stringify(saved.presets));
check('the retention choice stuck', saved.retentionMonths === 24, saved.retentionMonths);
check('the size choice stuck', saved.sizeCapBytes === 1000 * 1048576, saved.sizeCapBytes);
await page.close();

// --- the path where Chrome refuses ---------------------------------------
page = await openSetup(false);
await page.click('[data-next]');
await page.click('#chooseMode');
await page.waitForTimeout(200);
check('a refusal keeps you on the same screen', (await visibleStep(page)) === 1, await visibleStep(page));
const note = await page.textContent('#permissionNote');
check('a refusal is explained, with a way forward', /add sites one at a time/.test(note), note);
await page.close();

// --- strict mode ----------------------------------------------------------
page = await openSetup(false);
await page.click('[data-next]');
await page.check('input[value="strict"]');
await page.click('#chooseMode');
await page.waitForTimeout(200);
const strictRequested = await page.evaluate(() => window.__requested);
check('strict mode asks Chrome for nothing', strictRequested.length === 0, JSON.stringify(strictRequested));
check('strict mode skips the exclusion screen', (await visibleStep(page)) === 3, await visibleStep(page));
await page.click('#finish');
await page.waitForTimeout(400);
const strictSaved = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
});
check('strict mode was saved', strictSaved.mode === 'strict', strictSaved.mode);
const doneNote = await page.textContent('#doneNote');
check('strict mode says plainly that nothing is captured yet',
  /Nothing is being captured yet/.test(doneNote), doneNote);
await page.close();

await context.close();

let failed = 0;
for (const result of checks) {
  if (result.ok) console.log('  ok   ' + result.name);
  else { failed += 1; console.log('  FAIL ' + result.name + '\n       ' + result.detail); }
}
for (const error of errors) console.log('  page error: ' + error);
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed || errors.length ? 1 : 0);
