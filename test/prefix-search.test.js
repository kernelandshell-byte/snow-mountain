// Prefix matching, which BRIEF.md always meant as the thing that stands in for
// stemming, and which is deliberately a fallback rather than a default.
//
// The rule these hold down: a word that has postings of its own is searched
// exactly, always. Only a word that found nothing at all is widened. That is
// what stops a working search being quietly made noisier, and it is the whole
// difference between this and prefix matching everything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/db/memory-store.js';
import { search } from '../src/core/index-reader.js';

async function corpus() {
  const store = createMemoryStore();
  await store.putPage({
    url: 'https://a.example/one',
    title: 'Border crossings',
    text: 'The Israel trip took a whole day. Israeli border control asks a lot of questions.',
  });
  await store.putPage({
    url: 'https://b.example/two',
    title: 'Islands',
    text: 'The island chain is reachable by ferry, and the isolation is the point of going.',
  });
  await store.putPage({
    url: 'https://c.example/three',
    title: 'Cars and carbon',
    text: 'A car is a poor way to move one person. Carbon per passenger kilometre is the number that matters.',
  });
  return store;
}

test('a word that finds nothing matches the start of longer words', async () => {
  const store = await corpus();
  const result = await search('isra', { store });
  assert.equal(result.results.length, 1, 'the page about Israel comes back');
  assert.match(result.results[0].url, /a\.example/);
  assert.deepEqual(result.expanded.isra.sort(), ['israel', 'israeli'], 'and says what it matched');
});

test('a word that matches on its own is never widened', async () => {
  const store = await corpus();
  const result = await search('car', { store });
  assert.equal(result.results.length, 1, 'only the page with the word "car"');
  assert.equal(result.expanded.car, undefined, 'nothing was widened');
  // The point of the whole design: "carbon" is in that page too, but it is
  // not why the page matched, and a different page containing only "carbon"
  // would not have come back.
  const carbon = await search('carbon', { store });
  assert.equal(carbon.expanded.carbon, undefined, 'an exact match stays exact');
});

test('two letters is not a search', async () => {
  const store = await corpus();
  const result = await search('is', { store });
  assert.equal(result.expanded.is, undefined, 'below the floor, nothing is widened');
});

test('a widened word only matches the start of a word, not any part of it', async () => {
  const store = await corpus();
  const result = await search('sola', { store });
  // "isolation" contains "sola" but does not start with it.
  assert.equal(result.results.length, 0);
  assert.equal(result.expanded.sola, undefined);
});

test('a word inside a quoted phrase is never widened', async () => {
  const store = await corpus();
  const result = await search('"isra border"', { store });
  assert.equal(result.expanded.isra, undefined, 'a phrase is checked against real positions');
  assert.equal(result.results.length, 0, 'and no sentence contains that phrase');
});

test('an exact word and a widened one can be combined', async () => {
  const store = await corpus();
  const result = await search('isra border', { store });
  assert.equal(result.mode, 'and', 'both words had to match');
  assert.equal(result.results.length, 1);
  assert.deepEqual(Object.keys(result.expanded), ['isra'], 'only the word that needed it');
});

test('a widened word counts every spelling it matched', async () => {
  const store = createMemoryStore();
  await store.putPage({
    url: 'https://d.example/many',
    title: '',
    text: 'israel israel israeli israelis',
  });
  await store.putPage({ url: 'https://d.example/few', title: '', text: 'israel once, briefly' });
  const result = await search('isra', { store });
  assert.equal(result.results.length, 2);
  assert.match(result.results[0].url, /many/, 'four mentions outrank one');
});

test('the snippet marks the word that was found, not the word that was typed', async () => {
  const store = await corpus();
  const result = await search('isra', { store });
  assert.ok(result.results[0].snippet.ranges.length > 0, 'something is highlighted');
});

test('a store with no prefix support still answers', async () => {
  const store = await corpus();
  const without = { ...store, readTermsWithPrefix: undefined };
  const result = await search('isra', { store: without });
  assert.equal(result.results.length, 0, 'no match, and no crash');
  assert.deepEqual(result.expanded, {});
});
