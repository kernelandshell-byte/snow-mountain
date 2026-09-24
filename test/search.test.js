import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/db/memory-store.js';
import { search } from '../src/core/index-reader.js';

const DAY = 86400000;

async function corpus() {
  const store = createMemoryStore();
  await store.putPage({
    url: 'https://alpha.example/retro-fatigue',
    title: 'Why teams stop running retrospectives',
    text: 'Retro fatigue sets in when the same problems are raised every fortnight and nothing changes. The fix is rarely a new format, it is closing the loop on what was raised.',
    lastSeen: Date.now() - 30 * DAY,
  });
  await store.putPage({
    url: 'https://beta.example/churn-chart',
    title: 'Reading a churn cohort chart',
    text: 'Churn is easiest to see in a cohort chart where each row is a signup month. Retention flattens after month three for healthy products.',
    lastSeen: Date.now() - 2 * DAY,
  });
  await store.putPage({
    url: 'https://gamma.example/meetings',
    title: 'Meetings that survive contact with reality',
    text: 'Every recurring meeting should justify itself once a quarter. Retrospectives are the usual example, though standups suffer the same fate.',
    lastSeen: Date.now() - 200 * DAY,
  });
  return store;
}

test('finds the right page from a half remembered phrase', async () => {
  const store = await corpus();
  const r = await search('retro fatigue', { store });
  assert.equal(r.mode, 'and');
  assert.equal(r.results[0].url, 'https://alpha.example/retro-fatigue');
});

test('falls back to OR when one word is wrong, and says so', async () => {
  const store = await corpus();
  const r = await search('retro fatigue kangaroo', { store });
  assert.equal(r.mode, 'or');
  assert.equal(r.results[0].url, 'https://alpha.example/retro-fatigue');
});

test('matches terms that only appear in the title', async () => {
  const store = await corpus();
  const r = await search('cohort chart', { store });
  assert.equal(r.results[0].domain, 'beta.example');
});

test('site filter narrows to one domain', async () => {
  const store = await corpus();
  const r = await search('retrospectives site:gamma.example', { store });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].domain, 'gamma.example');
});

test('quoted phrases exclude documents that only have the words apart', async () => {
  const store = await corpus();
  const loose = await search('same problems', { store });
  assert.ok(loose.results.length >= 1);
  const strict = await search('"problems are raised"', { store });
  assert.equal(strict.results.length, 1);
  assert.equal(strict.results[0].domain, 'alpha.example');
  const absent = await search('"problems are kangaroos"', { store });
  assert.equal(absent.results.length, 0);
});

test('results carry a snippet with highlights', async () => {
  const store = await corpus();
  const r = await search('churn cohort', { store });
  assert.ok(r.results[0].snippet.text.length > 0);
  assert.ok(r.results[0].snippet.ranges.length > 0);
});

test('an empty query returns nothing rather than everything', async () => {
  const store = await corpus();
  const r = await search('   ', { store });
  assert.equal(r.mode, 'empty');
  assert.deepEqual(r.results, []);
});

test('recency breaks ties without overturning a better match', async () => {
  const store = createMemoryStore();
  await store.putPage({
    url: 'https://old.example/a',
    title: 'Indexing',
    text: 'postings buckets postings buckets postings buckets',
    lastSeen: Date.now() - 300 * DAY,
  });
  await store.putPage({
    url: 'https://new.example/b',
    title: 'Something else',
    text: 'postings mentioned once in passing here',
    lastSeen: Date.now(),
  });
  const r = await search('postings buckets', { store });
  assert.equal(r.results[0].domain, 'old.example');
});

test('a site filter from the interface narrows the results', async () => {
  const store = await corpus();
  const all = await search('retrospectives', { store });
  assert.ok(all.results.length > 1, 'the query should match more than one page');
  const narrowed = await search('retrospectives', { store, filters: { site: 'gamma.example' } });
  assert.equal(narrowed.results.length, 1);
  assert.equal(narrowed.results[0].domain, 'gamma.example');
});

test('a date filter drops pages read outside the window', async () => {
  const store = await corpus();
  const recent = await search('retrospectives', {
    store,
    filters: { after: Date.now() - 7 * 86400000 },
  });
  assert.ok(
    recent.results.every((r) => r.lastSeen >= Date.now() - 7 * 86400000),
    'everything returned should be inside the window'
  );
});

test('sorting by recency puts the newest first without changing what matched', async () => {
  const store = await corpus();
  const byScore = await search('retrospectives', { store });
  const byDate = await search('retrospectives', { store, filters: { sort: 'recent' } });
  assert.equal(byScore.total, byDate.total, 'the same pages matched');
  const dates = byDate.results.map((r) => r.lastSeen);
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a), 'newest first');
});

test('results report the domains that matched, for a filter that means something', async () => {
  const store = await corpus();
  const result = await search('retrospectives', { store });
  assert.ok(result.domains.length >= 2, JSON.stringify(result.domains));
  assert.ok(result.domains.every((entry) => entry.count > 0));
});

test('paging reports whether there is more and never repeats a result', async () => {
  const store = await corpus();
  const first = await search('retrospectives', { store, limit: 1, offset: 0 });
  assert.equal(first.hasMore, true);
  const second = await search('retrospectives', { store, limit: 1, offset: 1 });
  assert.notEqual(first.results[0].id, second.results[0].id);
  const past = await search('retrospectives', { store, limit: 20, offset: 0 });
  assert.equal(past.hasMore, false);
});

test('a -word excludes pages that contain it', async () => {
  const store = await corpus();
  const withBoth = await search('retrospectives', { store });
  assert.equal(withBoth.results.length, 2);

  const excluded = await search('retrospectives -fatigue', { store });
  assert.equal(excluded.results.length, 1);
  assert.ok(!excluded.results.some((r) => r.url.includes('retro-fatigue')));
});

test('excluding a word never changes whether the search ran as and or or', async () => {
  const store = await corpus();
  const result = await search('churn -fatigue', { store });
  assert.equal(result.mode, 'and');
});

// --- more matches than the shortlist -----------------------------------------

async function crowded() {
  const store = createMemoryStore();
  const now = Date.now();
  // 600 pages that say "kubernetes" a lot, on one site, a year ago.
  for (let i = 0; i < 600; i++) {
    await store.putPage({
      url: 'https://big.example/p' + i, title: 'Post ' + i,
      text: ('kubernetes cluster notes number ' + i + ' ').repeat(30),
      lastSeen: now - 400 * DAY + i,
    });
  }
  // One that says it once, on a site of its own, yesterday.
  await store.putPage({
    url: 'https://blog.mine.example/the-one', title: 'Home lab diary',
    text: 'I finally set up kubernetes on the old laptop, with a lot of patience for networking. ' + 'more homelab words '.repeat(20),
    lastSeen: now - DAY,
  });
  return store;
}

test('a site filter finds a match that ranks below the first few hundred', async () => {
  const store = await crowded();
  const fromUi = await search('kubernetes', { store, filters: { site: 'blog.mine.example' } });
  assert.deepEqual(fromUi.results.map((r) => r.url), ['https://blog.mine.example/the-one']);
  assert.equal(fromUi.total, 1);
  const typed = await search('kubernetes site:mine.example', { store });
  assert.deepEqual(typed.results.map((r) => r.url), ['https://blog.mine.example/the-one'], 'site: includes subdomains');
});

test('a date filter does too', async () => {
  const store = await crowded();
  const r = await search('kubernetes', { store, filters: { after: Date.now() - 7 * DAY } });
  assert.equal(r.total, 1);
});

test('newest first means newest of everything that matched', async () => {
  const store = await crowded();
  const r = await search('kubernetes', { store, filters: { sort: 'recent' }, limit: 1 });
  assert.equal(r.results[0].url, 'https://blog.mine.example/the-one');
});

test('the total is the real count, and paging carries on past the shortlist', async () => {
  const store = await crowded();
  const first = await search('kubernetes', { store, limit: 20 });
  assert.equal(first.total, 601);
  const seen = new Set();
  for (let offset = 0; offset < 601; offset += 100) {
    const page = await search('kubernetes', { store, limit: 100, offset });
    for (const row of page.results) seen.add(row.id);
    assert.equal(page.hasMore, offset + 100 < 601);
  }
  assert.equal(seen.size, 601, 'every match is reachable');
});

test('a phrase is part of the count, not a trim of the first page', async () => {
  const store = await crowded();
  const r = await search('"old laptop"', { store });
  assert.equal(r.total, 1);
});

// --- fewer matches than the shortlist ------------------------------------------
// Filtered from the records the ranking reads anyway rather than by walking
// the indexes, and it has to give exactly the answer the indexes would.

test('a small match is filtered and sorted the way the indexes would do it', async () => {
  const store = createMemoryStore();
  const now = Date.now();
  const hosts = ['mine.example', 'www.mine.example', 'blog.mine.example', 'notmine.example', 'other.example'];
  for (let i = 0; i < 40; i++) {
    await store.putPage({
      url: 'https://' + hosts[i % hosts.length] + '/p' + i, title: 'Post ' + i,
      text: 'sourdough starter notes ' + i + ' and more words about bread',
      // Pairs read in the same millisecond, so ties have to break the same way.
      lastSeen: now - Math.floor(i / 2) * DAY,
    });
  }
  const all = new Set((await search('sourdough', { store, limit: 100 })).results.map((r) => r.id));
  assert.equal(all.size, 40);

  const site = await search('sourdough', { store, limit: 100, filters: { site: 'mine.example' } });
  const expectedSite = (await store.pageIdsForSite('mine.example')).filter((id) => all.has(id));
  assert.deepEqual(site.results.map((r) => r.id).sort((a, b) => a - b), expectedSite.sort((a, b) => a - b));
  assert.equal(site.total, expectedSite.length);
  assert.ok(!site.results.some((r) => r.domain === 'notmine.example'), 'a suffix is not a subdomain');

  const after = now - 5 * DAY;
  const before = now - 2 * DAY;
  const dated = await search('sourdough', { store, limit: 100, filters: { after, before } });
  const expectedDated = (await store.pageIdsBetween(after, before + 1)).filter((id) => all.has(id));
  assert.deepEqual(dated.results.map((r) => r.id).sort((a, b) => a - b), expectedDated.sort((a, b) => a - b));

  const recent = await search('sourdough', { store, limit: 100, filters: { sort: 'recent' } });
  const expectedRecent = (await store.pageIdsByRecency()).filter((id) => all.has(id));
  assert.deepEqual(recent.results.map((r) => r.id), expectedRecent);
});
