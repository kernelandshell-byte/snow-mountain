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
