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
