// The settings page, including the two things the brief calls non
// negotiable: an export you can read without this extension, and a delete
// that actually deletes.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 900, height: 900 },
  acceptDownloads: true,
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

const checks = [];
const errors = [];
const check = (name, condition, detail) =>
  checks.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });

// Seed a few pages so there is something to report on.
const seed = await context.newPage();
await seed.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
const seeded = await seed.evaluate(async () => {
  const { CORPUS } = await import('/test/fixtures/corpus.js');
  const { MSG } = await import('/src/shared/messages.js');
  for (const doc of CORPUS.slice(0, 6)) {
    await chrome.runtime.sendMessage({
      type: MSG.PAGE_CONTENT,
      payload: { url: doc.url, title: doc.title, text: doc.text, capturedAt: Date.now() },
    });
  }
  return (await chrome.runtime.sendMessage({ type: MSG.STATS })).docCount;
});
await seed.close();
check('the fixture pages were captured', seeded === 6, seeded);

const page = await context.newPage();
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push('console: ' + message.text());
});
await page.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
await page.waitForFunction(() => document.getElementById('usage').textContent.length > 0);

const usage = await page.textContent('#usage');
check('usage is reported in pages and a sensible unit',
  /6 pages/.test(usage) && /\d+(\.\d+)?(B|KB|MB|GB) of \d+/.test(usage), usage);
check('a small corpus is not described as 0.0MB', !/0\.0MB of/.test(usage), usage);
check('capacity is expressed in pages', /room for roughly/.test(usage), usage);

const readSettings = () =>
  page.evaluate(async () => {
    const { MSG } = await import('/src/shared/messages.js');
    return chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
  });

await page.uncheck('[data-preset="health"]');
await page.waitForTimeout(300);
check('turning a bundle off is saved', (await readSettings()).presets.health === false, 'not saved');

await page.fill('#rules', 'example.com\n*.internal.example');
await page.waitForTimeout(1000);
const savedRules = (await readSettings()).customRules;
check('custom rules are saved once typing stops',
  savedRules.length === 2 && savedRules[0] === 'example.com', JSON.stringify(savedRules));

await page.selectOption('#months', '24');
await page.waitForTimeout(300);
check('retention is saved', (await readSettings()).retentionMonths === 24, 'not saved');

// Export
const download = await Promise.all([
  page.waitForEvent('download', { timeout: 10000 }),
  page.click('#export'),
]).then(([d]) => d);
const exportPath = await download.path();
const exported = JSON.parse(await readFile(exportPath, 'utf8'));
check('the export is named for the day it was made', /snow-mountain-\d{4}-\d{2}-\d{2}\.json/.test(download.suggestedFilename()), download.suggestedFilename());
check('the export holds every page', exported.pages.length === 6, exported.pages.length);
check('the export carries the full text, not a summary',
  exported.pages[0].text.length > 200, exported.pages[0].text.length);
check('the export carries readable dates',
  /^\d{4}-\d{2}-\d{2}T/.test(exported.pages[0].lastSeen), exported.pages[0].lastSeen);
check('the export records the settings too', exported.settings.retentionMonths === 24, JSON.stringify(exported.settings));

// Delete everything, which must take two clicks.
await page.click('#wipe');
await page.waitForTimeout(200);
const armedLabel = await page.textContent('#wipe');
check('the first click only arms the button', /Click again/.test(armedLabel), armedLabel);
const stillThere = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return (await chrome.runtime.sendMessage({ type: MSG.STATS })).docCount;
});
check('one click deletes nothing', stillThere === 6, stillThere);

await page.click('#wipe');
await page.waitForTimeout(600);
const afterWipe = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return (await chrome.runtime.sendMessage({ type: MSG.STATS })).docCount;
});
check('the second click deletes everything', afterWipe === 0, afterWipe);

const logText = await page.textContent('#log');
check('the deletion is in the log', /deleted by you/.test(logText), logText);

// --- switching modes, and whether strict mode means anything --------------
//
// The brief calls this the difference between this extension and every other
// one: strict mode is meant to be enforced by Chrome rather than promised by
// us, and it only is if switching away from broad mode actually hands the wide
// host permission back.
//
// chrome.permissions.remove cannot be proven end to end here, because granting
// the optional permission in the first place needs a click on a Chrome dialog
// that automation cannot reach, and the test harness therefore loads a copy
// with the permission required rather than optional. So what is held down is
// the call itself: that it is made, with the right origins, before the mode
// changes, and that the mode does not change if Chrome says no.
const modes = await context.newPage();
modes.on('pageerror', (error) => errors.push('modes page: ' + String(error)));
await modes.addInitScript(() => {
  window.__permissionCalls = [];
  const realRemove = chrome.permissions.remove.bind(chrome.permissions);
  const realRequest = chrome.permissions.request.bind(chrome.permissions);
  chrome.permissions.remove = (details) => {
    window.__permissionCalls.push({ op: 'remove', origins: details.origins });
    return Promise.resolve(true);
  };
  chrome.permissions.request = (details) => {
    window.__permissionCalls.push({ op: 'request', origins: details.origins });
    return Promise.resolve(window.__grant !== false);
  };
  window.__realPermissions = { realRemove, realRequest };
});
await modes.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');
await modes.waitForTimeout(300);

check('settings offers the choice of capture mode at all',
  (await modes.$$('input[name="mode"]')).length === 2,
  'there was no way to change mode after setup, so strict mode was unreachable');

await modes.click('input[name="mode"][value="strict"]');
await modes.waitForTimeout(400);
let calls = await modes.evaluate(() => window.__permissionCalls);
check('switching to strict hands the wide permission back to Chrome',
  calls.some((call) => call.op === 'remove' && call.origins.includes('*://*/*')),
  JSON.stringify(calls));

let saved = await modes.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
});
check('and the mode really is strict afterwards', saved.mode === 'strict', saved.mode);
check('and the exclusion list is put away, since nothing is read by default now',
  await modes.getAttribute('#presetBlock', 'hidden') !== null, 'exclusions still shown');
check('and the list of added sites takes its place',
  await modes.getAttribute('#allowBlock', 'hidden') === null, 'allowlist not shown');

// Removing a site has to take its permission back too, or the list is a lie.
await modes.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  await chrome.runtime.sendMessage({ type: MSG.SETTINGS_SET, payload: { allowlist: ['example.org'] } });
});
await modes.reload();
await modes.waitForTimeout(400);
check('an added site is listed', (await modes.textContent('#allowlist')).includes('example.org'),
  await modes.textContent('#allowlist'));
await modes.click('#allowlist .remove');
await modes.waitForTimeout(400);
calls = await modes.evaluate(() => window.__permissionCalls);
check('removing a site takes back Chrome\'s permission for it',
  calls.some((call) => call.op === 'remove' && call.origins.some((o) => o.includes('example.org'))),
  JSON.stringify(calls));
saved = await modes.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
});
check('and drops it from the list', !saved.allowlist.includes('example.org'), JSON.stringify(saved.allowlist));

// Going back to broad has to ask, and has to believe the answer.
await modes.evaluate(() => { window.__grant = false; });
await modes.click('input[name="mode"][value="broad"]');
await modes.waitForTimeout(400);
saved = await modes.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
});
check('a refused permission leaves the mode where it was',
  saved.mode === 'strict', 'it switched to broad without the access to do it');
check('and says so rather than failing silently',
  /did not grant/.test(await modes.textContent('#modeLine')), await modes.textContent('#modeLine'));
check('and the radio goes back to where it was',
  await modes.isChecked('input[name="mode"][value="strict"]'), 'the interface disagrees with the setting');

await modes.evaluate(() => { window.__grant = true; });
await modes.click('input[name="mode"][value="broad"]');
await modes.waitForTimeout(400);
calls = await modes.evaluate(() => window.__permissionCalls);
saved = await modes.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  return chrome.runtime.sendMessage({ type: MSG.SETTINGS_GET });
});
check('switching back to broad asks Chrome for the access first',
  calls.some((call) => call.op === 'request' && call.origins.includes('*://*/*')), JSON.stringify(calls));
check('and switches once it is granted', saved.mode === 'broad', saved.mode);
await modes.close();

// --- the round trip: export, delete everything, import it back ------------
await page.setInputFiles('#importFile', exportPath);
await page.waitForFunction(() => /imported/.test(document.getElementById('dataNote').textContent), null, { timeout: 15000 });
const importNote = await page.textContent('#dataNote');
check('importing reports what it restored', /6 imported/.test(importNote), importNote);

const restored = await page.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const stats = await chrome.runtime.sendMessage({ type: MSG.STATS });
  const found = await chrome.runtime.sendMessage({
    type: MSG.SEARCH,
    payload: { query: 'retro fatigue' },
  });
  const recent = await chrome.runtime.sendMessage({ type: MSG.RECENT, payload: { limit: 20 } });
  return { docCount: stats.docCount, hits: found.results.length, recent };
});
check('the pages are back', restored.docCount === 6, restored.docCount);
check('and searchable again', restored.hits === 1, restored.hits);

const oldest = restored.recent.find((p) => /retro-fatigue/.test(p.url));
check('history came back with them, not today\'s date',
  oldest && oldest.visitCount >= 1 && oldest.firstSeen <= oldest.lastSeen,
  JSON.stringify(oldest && { firstSeen: oldest.firstSeen, lastSeen: oldest.lastSeen }));

// Importing the same archive again should look like it did nothing.
await page.setInputFiles('#importFile', exportPath);
await page.waitForFunction(() => /already here/.test(document.getElementById('dataNote').textContent), null, { timeout: 15000 });
const secondNote = await page.textContent('#dataNote');
check('importing the same archive twice changes nothing', /6 already here/.test(secondNote), secondNote);

// And something that is not an export at all.
const junk = path.join(path.dirname(exportPath), 'not-an-export.json');
await writeFile(junk, JSON.stringify({ hello: 'world' }));
await page.setInputFiles('#importFile', junk);
await page.waitForTimeout(500);
check('a file that is not an export is refused clearly',
  /does not look like an export/.test(await page.textContent('#dataNote')), await page.textContent('#dataNote'));

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
