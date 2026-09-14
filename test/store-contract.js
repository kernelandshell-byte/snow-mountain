// One contract, two implementations. These cases run in Node against
// memory-store and in a real Chromium against idb-store, so a difference
// between the two shows up as a failing case rather than as a production bug
// six weeks later.
//
// No node: imports in this file. It has to run in a browser as well.

export function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || 'not equal') + ': expected ' + expected + ', got ' + actual);
  }
}

const PAGE = {
  url: 'https://example.com/retro-fatigue?utm_source=news',
  title: 'Why teams stop running retrospectives',
  text: 'Retro fatigue sets in when the same problems are raised every fortnight and nothing changes.',
};

export const contractCases = [
  {
    name: 'a stored page is retrievable and its terms are searchable',
    async run(store) {
      const { id, created } = await store.putPage(PAGE);
      assert(created, 'first write should create');
      const docs = await store.readDocs([id]);
      assertEqual(docs.get(id).title, PAGE.title, 'title round trip');
      const postings = await store.readTerm('fatigue');
      assertEqual(postings.length, 1, 'one document should carry the term');
      assertEqual(postings[0].id, id, 'posting points at the page');
    },
  },
  {
    name: 'title terms are indexed alongside body terms',
    async run(store) {
      const { id } = await store.putPage(PAGE);
      const postings = await store.readTerm('retrospectives');
      assertEqual(postings.length, 1, 'title term should be searchable');
      assertEqual(postings[0].id, id, 'and point at the right page');
    },
  },
  {
    name: 'the same url with tracking noise is the same page, not a second one',
    async run(store) {
      const first = await store.putPage(PAGE);
      const second = await store.putPage({
        ...PAGE,
        url: 'https://www.example.com/retro-fatigue?utm_source=twitter&utm_campaign=x',
      });
      assertEqual(second.id, first.id, 'same page id');
      assertEqual(second.created, false, 'not created again');
      assertEqual(second.reindexed, false, 'unchanged content needs no reindex');
      assertEqual((await store.readStats()).docCount, 1, 'still one document');
    },
  },
  {
    name: 'a revisit bumps the visit count without duplicating postings',
    async run(store) {
      const { id } = await store.putPage(PAGE);
      await store.putPage(PAGE);
      const docs = await store.readDocs([id]);
      assertEqual(docs.get(id).visitCount, 2, 'visit count');
      assertEqual((await store.readTerm('fatigue')).length, 1, 'no duplicate posting');
    },
  },
  {
    name: 'changed content reindexes in place and forgets the old words',
    async run(store) {
      const { id } = await store.putPage(PAGE);
      const again = await store.putPage({
        ...PAGE,
        text: 'The article was rewritten and now discusses kangaroos instead.',
      });
      assertEqual(again.id, id, 'same id, reindexed in place');
      assertEqual(again.reindexed, true, 'flagged as reindexed');
      assertEqual((await store.readTerm('fortnight')).length, 0, 'old term is gone');
      assertEqual((await store.readTerm('kangaroos')).length, 1, 'new term is present');
      assertEqual((await store.readStats()).docCount, 1, 'still one document');
    },
  },
  {
    name: 'statistics track document count and average length',
    async run(store) {
      await store.putPage(PAGE);
      await store.putPage({ url: 'https://other.example/a', title: 'Short', text: 'one two three' });
      const stats = await store.readStats();
      assertEqual(stats.docCount, 2, 'two documents');
      assert(stats.avgDocLength > 0, 'average length should be positive');
      assert(
        Math.abs(stats.avgDocLength - stats.totalTokens / 2) < 0.001,
        'average should match the totals'
      );
    },
  },
  {
    name: 'the byte total is kept as a running number, not recomputed',
    async run(store) {
      assertEqual((await store.readStats()).totalBytes, 0, 'starts empty');

      const { id } = await store.putPage(PAGE);
      const afterOne = (await store.readStats()).totalBytes;
      assert(afterOne > 0, 'counted the first page');

      // A revisit with identical content must not count the page twice.
      await store.putPage(PAGE);
      assertEqual((await store.readStats()).totalBytes, afterOne, 'a revisit changes nothing');

      // A rewrite replaces the old size rather than adding to it.
      await store.putPage({ ...PAGE, text: 'Much shorter now.' });
      const afterRewrite = (await store.readStats()).totalBytes;
      assert(afterRewrite < afterOne, 'shrinking the page shrinks the total: ' + afterRewrite);

      await store.deletePages([id]);
      assertEqual((await store.readStats()).totalBytes, 0, 'back to nothing');
    },
  },
  {
    name: 'the oldest page can be found without reading every page',
    async run(store) {
      assertEqual(await store.oldestFirstSeen(), null, 'nothing stored yet');
      const old = Date.now() - 400 * 86400000;
      await store.putPage({ url: 'https://a.example/1', title: 'Old', text: 'An old page.', lastSeen: old });
      await store.putPage({ url: 'https://b.example/2', title: 'New', text: 'A new page.' });
      assertEqual(await store.oldestFirstSeen(), old, 'the oldest first seen');
    },
  },
  {
    name: 'deleting a page removes its postings and its share of the statistics',
    async run(store) {
      const { id } = await store.putPage(PAGE);
      await store.putPage({ url: 'https://other.example/a', title: 'Short', text: 'one two three' });
      const result = await store.deletePages([id]);
      assertEqual(result.deleted, 1, 'one deleted');
      assert(result.bytesFreed > 0, 'freed bytes reported');
      assertEqual((await store.readTerm('fatigue')).length, 0, 'postings cleaned up');
      assertEqual((await store.readStats()).docCount, 1, 'count decremented');
      assertEqual((await store.readDocs([id])).size, 0, 'record gone');
    },
  },
  {
    name: 'deleting something that is not there is harmless',
    async run(store) {
      assertEqual((await store.deletePages([9999])).deleted, 0, 'nothing deleted');
    },
  },
  {
    name: 'pinning round trips',
    async run(store) {
      const { id } = await store.putPage(PAGE);
      assertEqual(await store.setPinned(id, true), true, 'pin succeeds');
      assertEqual((await store.readDocs([id])).get(id).pinned, 1, 'stored as pinned');
      assertEqual(await store.setPinned(4242, true), false, 'pinning a ghost fails quietly');
    },
  },
  {
    name: 'recent pages come back newest first',
    async run(store) {
      const now = Date.now();
      await store.putPage({ url: 'https://a.example/1', title: 'Older', text: 'alpha', lastSeen: now - 90000 });
      await store.putPage({ url: 'https://b.example/2', title: 'Newer', text: 'beta', lastSeen: now });
      const recent = await store.listRecent(5);
      assertEqual(recent[0].title, 'Newer', 'newest first');
      assertEqual(recent.length, 2, 'both returned');
    },
  },
  {
    name: 'term frequency and positions survive storage',
    async run(store) {
      const { id } = await store.putPage({
        url: 'https://c.example/x',
        title: '',
        text: 'cat dog cat bird cat',
      });
      const postings = await store.readTerm('cat');
      assertEqual(postings.length, 1, 'one document');
      assertEqual(postings[0].id, id, 'right document');
      assertEqual(postings[0].tf, 3, 'term frequency');
      assertEqual(postings[0].pos.join(','), '0,2,4', 'positions');
    },
  },
  {
    name: 'a page can be found by any spelling of its url',
    async run(store) {
      const { id } = await store.putPage(PAGE);
      const found = await store.getPageByUrl(
        'https://www.example.com/retro-fatigue?utm_campaign=elsewhere'
      );
      assert(found, 'the same page under a different spelling should be found');
      assertEqual(found.id, id, 'same page');
      assertEqual(await store.getPageByUrl('https://example.com/nothing-here'), null, 'a page that is not kept');
      assertEqual(await store.getPageByUrl('chrome://extensions'), null, 'an unindexable url');
    },
  },
  {
    name: 'page metadata comes back without dragging the text along',
    async run(store) {
      const { id } = await store.putPage(PAGE);
      const meta = await store.listPageMeta();
      assertEqual(meta.length, 1, 'one row');
      assertEqual(meta[0].id, id, 'right id');
      assert(meta[0].bytes > 0, 'bytes reported');
      assertEqual(meta[0].domain, 'example.com', 'domain included, for site rules');
      assert(!('text' in meta[0]), 'text must not be included');
      assert(!('title' in meta[0]), 'title must not be included');
    },
  },
  {
    name: 'the eviction log records what was removed, newest first',
    async run(store) {
      await store.logEviction({ reason: 'age', count: 3, bytesFreed: 900 });
      await store.logEviction({ reason: 'size', count: 1, bytesFreed: 100 });
      const log = await store.readEvictionLog(10);
      assertEqual(log.length, 2, 'two entries');
      assertEqual(log[0].reason, 'size', 'newest first');
      assertEqual(log[1].count, 3, 'older entry intact');
    },
  },
  {
    name: 'history can be restored rather than recorded as a visit today',
    async run(store) {
      const when = Date.now() - 200 * 86400000;
      const { id } = await store.putPage({
        url: 'https://restored.example/a',
        title: 'From an export',
        text: 'This page was read a long time ago and is being put back.',
        lastSeen: when,
        firstSeen: when - 86400000,
        visitCount: 7,
        pinned: true,
      });
      const doc = (await store.readDocs([id])).get(id);
      assertEqual(doc.visitCount, 7, 'visit count preserved');
      assertEqual(doc.firstSeen, when - 86400000, 'first seen preserved');
      assertEqual(doc.lastSeen, when, 'last seen preserved');
      assertEqual(doc.pinned, 1, 'pin preserved');
    },
  },
  {
    name: 'an unindexable url is refused rather than stored badly',
    async run(store) {
      let threw = false;
      try {
        await store.putPage({ url: 'chrome://extensions', title: 'x', text: 'y' });
      } catch {
        threw = true;
      }
      assert(threw, 'should have refused');
    },
  },
  {
    name: 'the sweep can read only the oldest pages, and only the expired ones',
    async run(store) {
      const day = 86400000;
      const now = Date.now();
      // Deliberately out of order, so nothing passes by accident of insertion.
      await store.putPage({ url: 'https://a.example/mid', title: 'Middle', text: 'A middling page.', lastSeen: now - 200 * day });
      await store.putPage({ url: 'https://a.example/new', title: 'Newest', text: 'A recent page.', lastSeen: now - day });
      await store.putPage({ url: 'https://a.example/old', title: 'Oldest', text: 'An ancient page.', lastSeen: now - 400 * day });

      const oldest = await store.oldestPages(10);
      assertEqual(oldest.length, 3, 'all three when the limit allows');
      assertEqual(oldest[0].title, undefined, 'the slice is metadata, not whole records');
      assert(oldest[0].lastSeen < oldest[1].lastSeen, 'oldest first');
      assert(oldest[1].lastSeen < oldest[2].lastSeen, 'and in order throughout');

      const limited = await store.oldestPages(1);
      assertEqual(limited.length, 1, 'the limit is honoured');
      assertEqual(limited[0].lastSeen, now - 400 * day, 'and it is the oldest one');

      const expired = await store.oldestPages(10, now - 300 * day);
      assertEqual(expired.length, 1, 'only pages past the cutoff');
      assertEqual(expired[0].lastSeen, now - 400 * day, 'and it is the right one');

      const none = await store.oldestPages(10, now - 500 * day);
      assertEqual(none.length, 0, 'nothing expired means nothing read');
    },
  },
  {
    name: 'one sweep is one row in the storage log, however many rounds it took',
    async run(store) {
      const now = Date.now();
      await store.logEviction({ reason: 'size', count: 3, bytesFreed: 300 }, { merge: true, now });
      await store.logEviction({ reason: 'size', count: 4, bytesFreed: 400 }, { merge: true, now: now + 1000 });
      await store.logEviction({ reason: 'size', count: 5, bytesFreed: 500 }, { merge: true, now: now + 2000 });

      let log = await store.readEvictionLog(20);
      assertEqual(log.length, 1, 'three rounds, one row');
      assertEqual(log[0].count, 12, 'the counts add up');
      assertEqual(log[0].bytesFreed, 1200, 'and so do the bytes');
      assertEqual(log[0].rounds, 3, 'the row remembers how many rounds it took');

      // A different reason is a different event, and so is one far enough
      // apart in time to be a separate sweep.
      await store.logEviction({ reason: 'age', count: 1, bytesFreed: 100 }, { merge: true, now: now + 3000 });
      await store.logEviction({ reason: 'size', count: 1, bytesFreed: 100 }, { merge: true, now: now + 40 * 60 * 1000 });
      log = await store.readEvictionLog(20);
      assertEqual(log.length, 3, 'a new reason and a later sweep each get their own row');
    },
  },
  {
    name: 'a large delete keeps the progress it made when it is stopped',
    async run(store) {
      const ids = [];
      for (let i = 0; i < 8; i++) {
        const { id } = await store.putPage({
          url: 'https://batch.example/page-' + i,
          title: 'Batch page ' + i,
          text: 'A page that exists so it can be deleted in batches, number ' + i + '.',
        });
        ids.push(id);
      }

      // What an interrupted sweep looks like: stopped part way through. The
      // signal is read once per batch, so counting reads is what "the worker
      // was stopped after three pages" means to the store.
      let reads = 0;
      const signal = { get aborted() { return ++reads > 3; } };
      const result = await store.deletePages(ids, { batch: 1, signal });

      const left = (await store.readStats()).docCount;
      assertEqual(left, 8 - result.deleted, 'what was deleted stayed deleted');
      assertEqual(result.deleted, 3, 'stopped after three, not at the end');
      assert(result.deleted > 0, 'and it kept what it had already done');
    },
  },
  {
    name: 'pages can be found by site and by day without reading the archive',
    async run(store) {
      const day = 86400000;
      const noon = new Date('2026-03-04T12:00:00Z').getTime();
      await store.putPage({ url: 'https://a.example/one', title: 'A one', text: 'The first page on site a.', lastSeen: noon });
      await store.putPage({ url: 'https://a.example/two', title: 'A two', text: 'The second page on site a.', lastSeen: noon + 3600000 });
      await store.putPage({ url: 'https://b.example/one', title: 'B one', text: 'The only page on site b.', lastSeen: noon });
      await store.putPage({ url: 'https://a.example/old', title: 'A old', text: 'An older page on site a.', lastSeen: noon - 5 * day });

      const bySite = await store.pageIdsByDomain('a.example');
      assertEqual(bySite.length, 3, 'three pages on that site');
      assertEqual((await store.pageIdsByDomain('nobody.example')).length, 0, 'and none on one with nothing');

      const dayStart = new Date('2026-03-04T00:00:00Z').getTime();
      const inDay = await store.pageIdsBetween(dayStart, dayStart + day);
      assertEqual(inDay.length, 3, 'three pages that day, across both sites');
      assertEqual((await store.pageIdsBetween(dayStart - 30 * day, dayStart - 29 * day)).length, 0, 'and none on a quiet day');
    },
  },
  {
    name: 'the archive can be walked a page at a time, for export',
    async run(store) {
      const ids = [];
      for (let i = 0; i < 7; i++) {
        const { id } = await store.putPage({
          url: 'https://walk.example/page-' + i,
          title: 'Walk ' + i,
          text: 'A page to be walked past during an export, number ' + i + '.',
        });
        ids.push(id);
      }

      const first = await store.listPagesFrom(0, 3);
      assertEqual(first.length, 3, 'a page at a time, three of them');
      assertEqual(first[0].id, ids[0], 'starting at the beginning');
      assert(first[0].text, 'and carrying the text, which is the point of an export');

      const second = await store.listPagesFrom(first[first.length - 1].id, 3);
      assertEqual(second[0].id, ids[3], 'continuing after the last one seen');

      const seen = new Set();
      let after = 0;
      for (let guard = 0; guard < 20; guard++) {
        const batch = await store.listPagesFrom(after, 3);
        if (!batch.length) break;
        for (const page of batch) seen.add(page.id);
        after = batch[batch.length - 1].id;
      }
      assertEqual(seen.size, 7, 'walking the whole archive sees every page exactly once');
    },
  },
  {
    name: 'the storage log keeps the newest entries rather than growing for ever',
    async run(store) {
      const { EVICTION_LOG_MAX } = await import('../src/shared/constants.js');
      const total = EVICTION_LOG_MAX + 25;
      // Far enough apart in time that none of them merge into one another.
      for (let i = 0; i < total; i++) {
        await store.logEviction({ reason: 'size', count: 1, bytesFreed: i }, { now: 1000 + i * 3600000 });
      }
      const log = await store.readEvictionLog(EVICTION_LOG_MAX + 100);
      assertEqual(log.length, EVICTION_LOG_MAX, 'capped at the maximum');
      assertEqual(log[0].bytesFreed, total - 1, 'and it is the newest that survived');
      assertEqual(log[log.length - 1].bytesFreed, total - EVICTION_LOG_MAX, 'the oldest went');
    },
  },
];
