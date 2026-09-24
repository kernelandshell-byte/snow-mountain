// Runs the store contract against the real IndexedDB implementation, inside
// a real Chromium, with the extension actually loaded. The Node suite runs
// the same cases against memory-store. Two implementations, one contract.
//
// Needs Playwright, which is a dev only dependency:
//   npm install --no-save playwright
//   node test/browser/run-store-contract.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    '--disable-extensions-except=' + root,
    '--load-extension=' + root,
    '--no-sandbox',
  ],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;

const page = await context.newPage();
await page.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html');

const results = await page.evaluate(async () => {
  const { openStore } = await import('/src/db/idb-store.js');
  const { contractCases } = await import('/test/store-contract.js');

  const wipe = (name) =>
    new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = resolve;
      request.onblocked = resolve;
    });

  const out = [];
  for (let i = 0; i < contractCases.length; i++) {
    // Every case gets its own database, so one failure cannot contaminate
    // the next and the order of cases never matters.
    const name = 'contract-' + i + '-' + Date.now();
    let store = null;
    const started = performance.now();
    try {
      store = await openStore({ name });
      await contractCases[i].run(store);
      out.push({ name: contractCases[i].name, ok: true, ms: Math.round(performance.now() - started) });
    } catch (error) {
      out.push({
        name: contractCases[i].name,
        ok: false,
        error: String((error && error.message) || error),
      });
    } finally {
      if (store) store.close();
      await wipe(name);
    }
  }
  return out;
});

await context.close();

let failed = 0;
for (const result of results) {
  if (result.ok) {
    console.log('  ok   ' + result.name + '  (' + result.ms + 'ms)');
  } else {
    failed += 1;
    console.log('  FAIL ' + result.name);
    console.log('       ' + result.error);
  }
}
console.log('');
console.log(results.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
