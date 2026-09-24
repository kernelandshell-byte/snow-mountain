// Bounded-edit-distance typo tolerance: the same fallback shape as the
// singular fallback and prefix widening, tried last because it is the
// broadest guess of the three. Reuses the prefix-scan mechanism, keyed on
// the query term's own first few characters (see TYPO_SCAN_PREFIX_CHARS),
// which is why a typo has to leave the start of the word alone to be found.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/db/memory-store.js';
import { search } from '../src/core/index-reader.js';

async function corpus() {
  const store = createMemoryStore();
  await store.putPage({
    url: 'https://a.example/one',
    title: 'Border crossings',
    text: 'The Israel trip took a whole day of driving.',
  });
  await store.putPage({
    url: 'https://b.example/two',
    title: 'Cars',
    text: 'A car is a poor way to move one person.',
  });
  return store;
}

test('a one letter substitution finds the real word', async () => {
  const store = await corpus();
  const result = await search('isreal', { store });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.expanded.isreal, ['israel']);
});

test('a word that matches exactly is never run through typo tolerance', async () => {
  const store = await corpus();
  const result = await search('israel', { store });
  assert.equal(result.expanded.israel, undefined);
});

test('below the character floor, nothing is corrected', async () => {
  const store = await corpus();
  const result = await search('cat', { store });
  assert.equal(result.results.length, 0);
  assert.deepEqual(result.expanded, {});
});

test('a transposition inside the scan prefix is the known blind spot', async () => {
  // "alhtough" is two edits from "although" (swap "lt"/"ht"), well inside
  // the budget for an eight letter word -- but the candidate scan is keyed
  // on the query's own first three characters, "alh", and the real word
  // lives under "alt". The scan never visits the bucket that has it.
  // Documented in TYPO_SCAN_PREFIX_CHARS rather than silently failing to
  // reproduce.
  const store = createMemoryStore();
  await store.putPage({ url: 'https://c.example/one', title: '', text: 'although it rained, we went' });
  const result = await search('alhtough', { store });
  assert.equal(result.results.length, 0);
});

test('a two letter word is never widened by typo tolerance either', async () => {
  const store = await corpus();
  const result = await search('is', { store });
  assert.equal(result.expanded.is, undefined);
});

test('a word inside a quoted phrase is never typo-corrected', async () => {
  const store = await corpus();
  const result = await search('"isreal trip"', { store });
  assert.equal(result.expanded.isreal, undefined);
  assert.equal(result.results.length, 0);
});

test('a store with no prefix support still answers', async () => {
  const store = await corpus();
  const without = { ...store, readTermsWithPrefix: undefined };
  const result = await search('isreal', { store: without });
  assert.equal(result.results.length, 0);
  assert.deepEqual(result.expanded, {});
});

test('the singular and prefix fallbacks still run first', async () => {
  // "isra" already has its own, more precise widening story (see
  // prefix-search.test.js); typo tolerance should never be reached for it.
  const store = await corpus();
  const result = await search('isra', { store });
  assert.deepEqual(result.expanded.isra, ['israel']);
});
