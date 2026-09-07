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
