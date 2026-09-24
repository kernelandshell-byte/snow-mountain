// What happens when things go wrong underneath: storage disappearing, the
// background worker being killed in the middle of writing, the extension
// being reloaded, and the interface being handed an error instead of results.
//
// None of this is exotic. Clearing browsing data deletes the database out
// from under a running extension, and Manifest V3 stops the worker whenever
// it feels like it.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { invariantCheck } from './invariants.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// A real profile directory, so the browser can be closed and opened again
// with everything still in it. That is the question that matters: does an
// archive survive a restart?
const profile = await mkdtemp(path.join(tmpdir(), 'sm-profile-'));
const launch = () =>
  chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 900, height: 700 },
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
  });

let context = await launch();

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
let extensionId = new URL(worker.url()).host;

const checks = [];
const errors = [];
const check = (name, condition, detail) => {
  const result = { name, ok: !!condition, detail: condition ? '' : String(detail) };
  checks.push(result);
  console.log(result.ok ? '  ok   ' + name : '  FAIL ' + name + '\n       ' + result.detail);
  return result.ok;
};

const optionsUrl = () => 'chrome-extension://' + extensionId + '/src/ui/options/options.html';

async function driverPage() {
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  // Straight after a reload the extension is briefly not there yet, and
  // Chrome answers with ERR_BLOCKED_BY_CLIENT rather than waiting.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await page.goto(optionsUrl());
      return page;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return page;
}

const ask = (page, type, payload) =>
  page.evaluate(
    async ({ t, p }) => {
      const { MSG } = await import('/src/shared/messages.js');
      return chrome.runtime.sendMessage({ type: MSG[t], payload: p });
    },
    { t: type, p: payload }
  );

const seed = (page, count, prefix) =>
  page.evaluate(
    async ({ n, tag }) => {
      const { MSG } = await import('/src/shared/messages.js');
      for (let i = 0; i < n; i++) {
        await chrome.runtime.sendMessage({
          type: MSG.PAGE_CONTENT,
          payload: {
            url: 'https://' + tag + '.example/page-' + i,
            title: tag + ' page ' + i,
            text: 'A page about indexing and retention and eviction, number ' + i + ', with enough words in it to be worth keeping.',
            capturedAt: Date.now(),
          },
        });
      }
      return (await chrome.runtime.sendMessage({ type: MSG.STATS })).docCount;
    },
    { n: count, tag: prefix }
  );

let driver = await driverPage();
await ask(driver, 'SETTINGS_SET', { setupComplete: true, mode: 'broad' });

// --- the interface being handed an error ----------------------------------
const search = await context.newPage();
search.on('pageerror', (error) => errors.push('search page: ' + String(error)));
await search.addInitScript(() => {
  const original = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (message) => {
    if (message && message.type === 'SEARCH') return Promise.resolve({ error: 'storage exploded' });
    return original(message);
  };
});
await search.goto('chrome-extension://' + extensionId + '/src/ui/search/search.html');
await search.fill('#q', 'anything at all');
await search.waitForTimeout(500);
const errorText = await search.textContent('#results');
check('the search page explains a failure instead of going blank',
  /not available right now/.test(errorText), errorText.slice(0, 120));
check('and it does not throw while doing so', errors.length === 0, JSON.stringify(errors));

// It has to keep working once the problem goes away.
await search.evaluate(() => {
  chrome.runtime.sendMessage = chrome.runtime.sendMessage.__original || chrome.runtime.sendMessage;
});
await search.close();

// --- storage deleted underneath a running extension -----------------------
const before = await seed(driver, 5, 'beforewipe');
check('pages are stored to begin with', before === 5, before);

const deletion = await driver.evaluate(async () => {
  // What clearing browsing data does, from in here. Waiting for it to
  // actually finish matters: a deletion that is merely queued will land
  // later and wipe whatever was written in the meantime, which is a very
  // confusing way to lose data.
  return new Promise((resolve) => {
    let blocked = false;
    const request = indexedDB.deleteDatabase('archive');
    request.onsuccess = () => resolve(blocked ? 'deleted after being blocked' : 'deleted');
    request.onerror = () => resolve('error');
    request.onblocked = () => { blocked = true; };
    setTimeout(() => resolve('still blocked after five seconds'), 5000);
  });
});
check('a connection held by the worker does not block the deletion',
  deletion === 'deleted' || deletion === 'deleted after being blocked', deletion);
await driver.waitForTimeout(400);

const afterWipe = await ask(driver, 'STATS');
check('the extension answers rather than failing after its database is deleted',
  afterWipe && !afterWipe.error, JSON.stringify(afterWipe));
check('and reports an empty archive, which is the truth',
  afterWipe.docCount === 0, afterWipe.docCount);

const rebuilt = await seed(driver, 3, 'afterwipe');
check('capture works again straight away', rebuilt === 3, rebuilt);
const searchAfterWipe = await ask(driver, 'SEARCH', { query: 'indexing retention' });
check('and the new pages are searchable', searchAfterWipe.results.length === 3, searchAfterWipe.results.length);

// --- the worker killed in the middle of writing ---------------------------
const cdp = await context.newCDPSession(driver);
await cdp.send('ServiceWorker.enable');

const writing = driver.evaluate(async () => {
  const { MSG } = await import('/src/shared/messages.js');
  const jobs = [];
  for (let i = 0; i < 30; i++) {
    jobs.push(
      chrome.runtime
        .sendMessage({
          type: MSG.PAGE_CONTENT,
          payload: {
            url: 'https://killed.example/page-' + i,
            title: 'Killed page ' + i,
            text: 'A page written while the worker was about to be stopped, number ' + i + ', long enough to index properly.',
            capturedAt: Date.now(),
          },
        })
        .catch(() => null)
    );
  }
  return (await Promise.all(jobs)).filter(Boolean).length;
});
await driver.waitForTimeout(120);
await cdp.send('ServiceWorker.stopAllWorkers');
const survivedWrites = await writing;
await driver.waitForTimeout(800);

const afterKill = await ask(driver, 'STATS');
check('the worker comes back after being killed mid write',
  afterKill && !afterKill.error, JSON.stringify(afterKill));
const killInvariants = await driver.evaluate(invariantCheck, null);
console.log('  note  ' + survivedWrites + ' of 30 writes acknowledged, worker reports ' +
  (afterKill && afterKill.docCount) + ' pages, database holds ' + killInvariants.pages);
check('the worker and the database agree on how many pages there are',
  afterKill.docCount === killInvariants.pages,
  'worker says ' + afterKill.docCount + ', database has ' + killInvariants.pages);
check('and the index is still internally consistent',
  killInvariants.problems.length === 0, JSON.stringify(killInvariants.problems));

// --- the browser closed and opened again -----------------------------------
const beforeRestart = await ask(driver, 'STATS');
await ask(driver, 'SETTINGS_SET', { retentionMonths: 6, customRules: ['restart.example'] });
await context.close();

context = await launch();
driver = await driverPage();

const afterRestart = await ask(driver, 'STATS');
check('the archive is still there after the browser is closed and reopened',
  afterRestart.docCount === beforeRestart.docCount,
  beforeRestart.docCount + ' before, ' + afterRestart.docCount + ' after');

const settingsAfterRestart = await ask(driver, 'SETTINGS_GET');
check('and so are the settings',
  settingsAfterRestart.retentionMonths === 6 && settingsAfterRestart.customRules.includes('restart.example'),
  JSON.stringify(settingsAfterRestart));

const searchAfterRestart = await ask(driver, 'SEARCH', { query: 'indexing retention' });
check('search works on the restored archive', searchAfterRestart.results.length > 0, searchAfterRestart.results.length);

const captureAfterRestart = await ask(driver, 'PAGE_CONTENT', {
  url: 'https://afterrestart.example/a',
  title: 'After the restart',
  text: 'A page captured after the browser was closed and opened again.',
  capturedAt: Date.now(),
});
check('and capture works', captureAfterRestart.ok === true, JSON.stringify(captureAfterRestart));

const finalInvariants = await driver.evaluate(invariantCheck, null);
check('the index is consistent at the end of all that',
  finalInvariants.problems.length === 0, JSON.stringify(finalInvariants.problems));

await context.close();
await rm(profile, { recursive: true, force: true });

const failed = checks.filter((result) => !result.ok).length;
console.log('');
console.log(checks.length - failed + ' passed, ' + failed + ' failed');
for (const error of errors) console.log('  page error: ' + error);
process.exit(failed ? 1 : 0);
