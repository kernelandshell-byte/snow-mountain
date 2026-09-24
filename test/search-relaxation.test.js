import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/db/memory-store.js';
import { search } from '../src/core/index-reader.js';

async function store() {
  const s = createMemoryStore();
  await s.putPage({
    url: 'https://a.example/1',
    title: 'Reading a cohort chart',
    text: 'The chart puts each signup month on its own row.',
  });
  return s;
}

test('a plural query finds the singular and says it did so', async () => {
  const result = await search('charts', { store: await store() });
  assert.equal(result.results.length, 1);
  assert.equal(result.relaxed.charts, 'chart');
});

test('a term that exists is never relaxed', async () => {
  const result = await search('chart', { store: await store() });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.relaxed, {});
});

test('a word that matches nothing at all stays unmatched', async () => {
  const result = await search('kangaroos', { store: await store() });
  assert.equal(result.results.length, 0);
  assert.deepEqual(result.relaxed, {});
});

test("a phrase word is never relaxed to a different word's positions", async () => {
  // This document never contains the word "cars" anywhere, only the
  // unrelated literal run "car are great" (singular). Relaxing "cars" to
  // "car" for phrase checking would make the quoted phrase match a page
  // that does not contain it, which is worse than finding nothing.
  const s = createMemoryStore();
  await s.putPage({
    url: 'https://a.example/1',
    title: 'Towing',
    text: 'This car are great for towing, according to the review.',
  });
  const result = await search('"cars are great"', { store: s });
  assert.equal(result.results.length, 0);
  assert.deepEqual(result.relaxed, {});
});
