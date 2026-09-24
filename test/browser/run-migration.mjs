// The migration policy, exercised.
//
// There is only schema version 1, so nothing here migrates a real archive.
// That is exactly why it exists: the day a second version is needed is a bad
// day to find out whether any of the policy works. The
// machinery is driven with fixture migrations, including ones designed to
// fail, and the thing being checked is always the same: after a failure, is
// the old data still there and does the extension say so.
//
//   node test/browser/run-migration.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-sandbox'],
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker');

const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto('chrome-extension://' + new URL(worker.url()).host + '/src/ui/options/options.html');

const results = await page.evaluate(async () => {
  const { openStore, openDatabase } = await import('/src/db/idb-store.js');
  const { STORES } = await import('/src/db/schema.js');

  const out = [];
  const check = (name, condition, detail) =>
    out.push({ name, ok: !!condition, detail: condition ? '' : String(detail) });

  const dropDatabase = (name) =>
    new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = resolve;
      request.onblocked = resolve;
      setTimeout(resolve, 3000);
    });

  const readAll = (db, storeName) =>
    new Promise((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  // A version 1 archive with real content in it, written through the real
  // store rather than poked into the database, so what is being migrated is
  // what this extension actually produces.
  async function seedV1(name, count) {
    const store = await openStore({ name });
    for (let i = 0; i < count; i++) {
      await store.putPage({
        url: 'https://migrate' + (i % 5) + '.example/page-' + i,
        title: 'Page ' + i + ' about retention',
        text: 'A page written before the migration, number ' + i +
          ', with a unique word oldneedle' + i + ' and ordinary words around it to index.',
        lastSeen: Date.now() - i * 3600000,
      });
    }
    if (count > 0) await store.setPinned(1, true);
    store.close();
  }

  // The fixture: rebuild `pages` with a `lang` field filled in and an index on
  // it. Small, but it is a real store rebuild, which is the part that has to
  // be proven safe.
  const addLanguage = {
    version: 2,
    describe: 'record a language on every page',
    async run(db, tx, { rebuildStore }) {
      return rebuildStore(db, tx, {
        name: 'pages',
        spec: {
          ...STORES.pages,
          indexes: [...STORES.pages.indexes, { name: 'lang', keyPath: 'lang' }],
        },
        transform: (row) => ({ ...row, lang: 'en' }),
        verify: async (sample) => {
          for (const row of sample) {
            if (row.lang !== 'en') throw new Error('a sampled record came out wrong');
            if (!row.text) throw new Error('a sampled record lost its text');
          }
        },
      });
    },
  };

  // ------------------------------------------------------------------ happy
  {
    const name = 'migration-ok-' + Date.now();
    await seedV1(name, 40);

    const before = await openDatabase({ name });
    const beforePages = await readAll(before, 'pages');
    const beforePostings = await readAll(before, 'postings');
    before.close();

    let announced = null;
    const db = await openDatabase({
      name,
      version: 2,
      migrations: [addLanguage],
      onMigrated: (applied, versions) => { announced = { applied, versions }; },
    });

    const afterPages = await readAll(db, 'pages');
    const afterPostings = await readAll(db, 'postings');
    const meta = await readAll(db, 'meta');
    const schema = meta.find((row) => row.key === 'schema');
    const stats = meta.find((row) => row.key === 'stats');

    check('a migration keeps every page', afterPages.length === beforePages.length,
      beforePages.length + ' before, ' + afterPages.length + ' after');
    check('and every page keeps its text',
      afterPages.every((row) => row.text && row.text.length > 20), 'text was lost');
    check('and its identity', afterPages.every((row, i) => row.id === beforePages[i].id),
      'ids were renumbered, which would orphan every posting');
    check('and its pin', afterPages.filter((row) => row.pinned).length === beforePages.filter((row) => row.pinned).length,
      'a pin was lost, and a pin is a promise');
    check('the migration actually did its work',
      afterPages.every((row) => row.lang === 'en'), 'the transform did not run');
    check('the index it added is there',
      [...db.transaction('pages', 'readonly').objectStore('pages').indexNames].includes('lang'),
      'no lang index');
    check('the postings are untouched', afterPostings.length === beforePostings.length,
      beforePostings.length + ' before, ' + afterPostings.length + ' after');
    check('the running totals survive', stats && stats.docCount === beforePages.length,
      JSON.stringify(stats));
    check('the version is recorded in the database itself, not only in IndexedDB',
      schema && schema.version === 2 && db.version === 2,
      JSON.stringify(schema) + ' vs ' + db.version);
    check('and the extension is told, so it can say so once',
      announced && announced.applied.length === 1 && announced.applied[0].version === 2,
      JSON.stringify(announced));

    // The whole point of keeping the ids: the index still finds things.
    const { search } = await import('/src/core/index-reader.js');
    const { createIdbStore } = await import('/src/db/idb-store.js');
    const migrated = createIdbStore(db);
    const found = await search('oldneedle7', { store: migrated, limit: 5 });
    check('and the archive is still searchable afterwards', found.results.length === 1,
      found.results.length + ' results for a word that is in exactly one page');

    // The quiet one. Rebuilding an auto incrementing store means deleting it
    // and adding every record back with an explicit key, and if the key
    // generator does not come back with it, the next page written after an
    // upgrade gets an id that already belongs to another page. Nothing throws;
    // the archive just starts overwriting itself from the beginning.
    const highest = Math.max(...afterPages.map((row) => row.id));
    const next = await migrated.putPage({
      url: 'https://after-the-migration.example/first-new-page',
      title: 'Written after the upgrade',
      text: 'The first page captured after a migration, with afterneedle in it.',
    });
    check('the next page written after a migration does not reuse an id',
      next.id > highest, 'got id ' + next.id + ' when the archive already goes up to ' + highest);

    const collided = await readAll(db, 'pages');
    check('and nothing was overwritten by it',
      collided.length === afterPages.length + 1,
      afterPages.length + ' pages before, ' + collided.length + ' after adding one');

    db.close();
    await dropDatabase(name);
  }

  // ---------------------------------------------------------------- failures
  const failures = [
    {
      label: 'a migration that throws half way through',
      migration: {
        version: 2,
        describe: 'fail on purpose',
        async run(db, tx, { rebuildStore }) {
          return rebuildStore(db, tx, {
            name: 'pages',
            spec: STORES.pages,
            transform: (row) => {
              if (row.id === 5) throw new Error('deliberate failure part way through');
              return { ...row, lang: 'en' };
            },
          });
        },
      },
    },
    {
      label: 'a migration whose verification finds something wrong',
      migration: {
        version: 2,
        describe: 'fail verification',
        async run(db, tx, { rebuildStore }) {
          return rebuildStore(db, tx, {
            name: 'pages',
            spec: STORES.pages,
            transform: (row) => ({ ...row, lang: 'en' }),
            verify: async () => { throw new Error('the sample did not look right'); },
          });
        },
      },
    },
    {
      label: 'a migration that would quietly drop records',
      migration: {
        version: 2,
        describe: 'lose records',
        async run(db, tx, { rebuildStore }) {
          return rebuildStore(db, tx, {
            name: 'pages',
            spec: STORES.pages,
            // Returning nothing for a row is how a real transform loses data:
            // a filter that was meant to be a map.
            transform: (row) => (row.id % 3 === 0 ? null : row),
          });
        },
      },
    },
  ];

  for (const { label, migration } of failures) {
    const name = 'migration-fail-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    await seedV1(name, 20);

    let threw = null;
    try {
      const db = await openDatabase({ name, version: 2, migrations: [migration] });
      db.close();
    } catch (error) {
      threw = String(error.message || error);
    }
    check(label + ': is refused rather than half applied', threw !== null,
      'it was allowed through, which is the failure this policy exists to prevent');

    // And the database is still exactly what it was, at its old version.
    const again = await openDatabase({ name });
    const pages = await readAll(again, 'pages');
    const postings = await readAll(again, 'postings');
    const schema = (await readAll(again, 'meta')).find((row) => row.key === 'schema');
    check(label + ': leaves the old database at its old version',
      again.version === 1 && schema && schema.version === 1,
      'version ' + again.version + ', schema row ' + JSON.stringify(schema));
    check(label + ': leaves every page where it was',
      pages.length === 20 && pages.every((row) => row.text && !row.lang),
      pages.length + ' pages, lang present on ' + pages.filter((r) => r.lang).length);
    check(label + ': and the index with them',
      postings.length > 0, 'postings were lost');

    const { search } = await import('/src/core/index-reader.js');
    const { createIdbStore } = await import('/src/db/idb-store.js');
    const found = await search('oldneedle3', { store: createIdbStore(again), limit: 5 });
    check(label + ': and the archive still searchable',
      found.results.length === 1, found.results.length);

    again.close();
    await dropDatabase(name);
  }

  // ------------------------------------------------------- version disputes
  {
    const name = 'migration-newer-' + Date.now();
    await seedV1(name, 5);
    const bumped = await openDatabase({ name, version: 2, migrations: [] });
    bumped.close();

    let threw = null;
    try {
      const db = await openDatabase({ name, version: 1 });
      db.close();
    } catch (error) {
      threw = String(error.message || error);
    }
    check('an older build refuses a database written by a newer one', threw !== null, 'it opened it');
    check('and says so in words somebody can act on',
      threw && /newer version/i.test(threw) && /nothing has been changed/i.test(threw), threw);

    const still = await openDatabase({ name, version: 2, migrations: [] });
    const pages = await readAll(still, 'pages');
    check('and the refusal changed nothing', pages.length === 5, pages.length);
    still.close();
    await dropDatabase(name);
  }

  {
    // What a half finished upgrade looks like afterwards: the database version
    // and the database's own record of itself disagree.
    const name = 'migration-mismatch-' + Date.now();
    await seedV1(name, 5);
    const db = await openDatabase({ name });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      const request = tx.objectStore('meta').put({ key: 'schema', version: 7 });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    db.close();

    let threw = null;
    try {
      const again = await openDatabase({ name });
      again.close();
    } catch (error) {
      threw = String(error.message || error);
    }
    check('a database whose two version numbers disagree refuses to open', threw !== null,
      'it opened one that did not finish upgrading');
    check('and says that too, rather than showing an empty archive',
      threw && /did not finish an upgrade/i.test(threw) && /nothing has been changed/i.test(threw), threw);
    await dropDatabase(name);
  }

  return out;
});

await context.close();

let failed = 0;
for (const result of results) {
  if (result.ok) console.log('  ok   ' + result.name);
  else {
    failed += 1;
    console.log('  FAIL ' + result.name + '\n       ' + result.detail);
  }
}
for (const error of errors) console.log('  page error: ' + error);
console.log('');
console.log(results.length - failed + ' passed, ' + failed + ' failed');
process.exit(failed || errors.length ? 1 : 0);
