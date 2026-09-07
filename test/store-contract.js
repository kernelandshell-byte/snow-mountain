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
];
