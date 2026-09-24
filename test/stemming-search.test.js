// Query-time stemming, the same fallback shape as the singular fallback and
// prefix widening: only tried once a term finds nothing at all, and never
// applied inside a quoted phrase.
//
// Every case here is deliberately chosen so the stem is not a literal
// prefix of the query term (or vice versa) -- otherwise prefix widening
// would already answer it and the test would not be exercising stemming
// at all. A query that is a longer inflected form than what is indexed
// ("running" against a page that only says "run") is the shape that
// isolates it: prefix widening only ever extends the query, so it cannot
// reach a shorter word the query does not literally start with.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/db/memory-store.js';
import { search } from '../src/core/index-reader.js';

async function corpus() {
  const store = createMemoryStore();
  await store.putPage({
    url: 'https://a.example/one',
    title: 'A morning run',
    text: 'A short run every morning changed how the whole day felt.',
  });
  await store.putPage({
    url: 'https://b.example/two',
    title: 'Moving around',
    text: 'A car is a poor way to move one person.',
  });
  return store;
}

test('a longer query finds a shorter word sharing its stem', async () => {
  const store = await corpus();
  const result = await search('running', { store, stemLanguages: ['en'] });
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].url, /a\.example/);
  assert.deepEqual(result.expanded.running, ['run']);
});

test('stemming is off unless a language is enabled', async () => {
  const store = await corpus();
  const result = await search('running', { store });
  assert.equal(result.results.length, 0);
  assert.deepEqual(result.expanded, {});
});

test('a word that already has postings is never stemmed', async () => {
  const store = await corpus();
  const result = await search('car', { store, stemLanguages: ['en'] });
  assert.equal(result.results.length, 1);
  assert.equal(result.expanded.car, undefined);
});

test('a word inside a quoted phrase is never stemmed', async () => {
  const store = await corpus();
  const result = await search('"running every morning"', { store, stemLanguages: ['en'] });
  assert.equal(result.expanded.running, undefined);
  assert.equal(result.results.length, 0);
});

test('a store with no prefix support still answers', async () => {
  const store = await corpus();
  const without = { ...store, readTermsWithPrefix: undefined };
  const result = await search('running', { store: without, stemLanguages: ['en'] });
  assert.equal(result.results.length, 0);
  assert.deepEqual(result.expanded, {});
});

test('the singular fallback still runs first', async () => {
  // "cars" has both a singular reading (car, present) and a stem (car,
  // same word here) -- the point is that the cheaper, more precise
  // singular fallback gets first refusal and stemming is never reached.
  const store = await corpus();
  const result = await search('cars', { store, stemLanguages: ['en'] });
  assert.equal(result.relaxed.cars, 'car');
  assert.equal(result.expanded.cars, undefined);
});

test('only the enabled languages are tried', async () => {
  // The gap between query and target is kept wider than the typo-tolerance
  // budget (4 characters here), so a pass without Dutch enabled cannot
  // pass for the wrong reason -- typo tolerance runs unconditionally and
  // would otherwise paper over a language gate that was not actually
  // doing anything.
  const store = createMemoryStore();
  await store.putPage({
    url: 'https://c.example/one',
    title: '',
    text: 'dat was best moeilijk vandaag',
  });
  const withoutDutch = await search('moeilijkheid', { store, stemLanguages: ['en'] });
  assert.equal(withoutDutch.results.length, 0, 'Dutch is not enabled');

  const withDutch = await search('moeilijkheid', { store, stemLanguages: ['en', 'nl'] });
  assert.equal(withDutch.results.length, 1);
  assert.deepEqual(withDutch.expanded.moeilijkheid, ['moeilijk']);
});

test('the German stemmer folds an ASCII umlaut spelling as part of stemming', async () => {
  // "muenchen" is one edit from "munchen" -- the tokenizer's own folded
  // form of "münchen" -- which is well inside a typo-tolerance budget, but
  // that edit is the extra "e" inside the first three characters, so it
  // changes which bucket the scan-prefix blind spot lands in: "mue" never
  // finds a term stored under "mun". Only stemming reaches this, because
  // the German stemmer normalises "ue" the same way it would a real
  // umlaut, before it ever gets to stripping a suffix.
  const store = createMemoryStore();
  await store.putPage({ url: 'https://d.example/one', title: '', text: 'ein foto aus munchen' });
  const withoutStemming = await search('muenchen', { store });
  assert.equal(withoutStemming.results.length, 0, 'not reachable without stemming');

  const withGerman = await search('muenchen', { store, stemLanguages: ['de'] });
  assert.equal(withGerman.results.length, 1);
  assert.deepEqual(withGerman.expanded.muenchen, ['munchen']);
});

// The six. Each on a page that only has one form of the word and a query
// for a different form of it, far enough apart that neither the singular,
// prefix widening nor typo tolerance could have bridged them.
const LANGUAGE_CASES = [
  ['es', 'seguían hablando de lo mismo', 'hablaban', 'hablando'],
  ['pt', 'uma nova informação chegou ontem', 'informações', 'informacao'],
  ['fr', 'la lecture est continuée demain matin', 'continuerons', 'continuee'],
  ['it', 'ne abbiamo parlato a lungo', 'parlavano', 'parlato'],
];

for (const [lang, text, query, found] of LANGUAGE_CASES) {
  test(lang + ': a different form of a word finds the page, only with ' + lang + ' enabled', async () => {
    const store = createMemoryStore();
    await store.putPage({ url: 'https://' + lang + '.example/one', title: '', text });

    const without = await search(query, { store, stemLanguages: ['en'] });
    assert.equal(without.results.length, 0, 'not reachable without ' + lang);

    const withLanguage = await search(query, { store, stemLanguages: ['en', lang] });
    assert.equal(withLanguage.results.length, 1);
    assert.deepEqual(Object.values(withLanguage.expanded), [[found]]);
  });
}

test('with all seven enabled, each case still finds exactly its own page', async () => {
  const store = createMemoryStore();
  for (const [lang, text] of LANGUAGE_CASES) {
    await store.putPage({ url: 'https://' + lang + '.example/one', title: '', text });
  }
  for (const [lang, , query] of LANGUAGE_CASES) {
    const result = await search(query, { store, stemLanguages: ['en', 'es', 'pt', 'de', 'fr', 'it', 'nl'] });
    assert.deepEqual(result.results.map((r) => r.url), ['https://' + lang + '.example/one'], query);
  }
});

test('languages that agree on a stem share one scan of it', async () => {
  // Each prefix scan reads real posting lists, and Spanish, Portuguese,
  // French and Italian often compute the same stem for the same word.
  const store = createMemoryStore();
  await store.putPage({ url: 'https://a.example/one', title: '', text: 'organizar organizado organizaba' });
  const calls = [];
  const counting = {
    ...store,
    readTermsWithPrefix: (prefix, options) => {
      calls.push(prefix + ' ' + JSON.stringify(options || {}));
      return store.readTermsWithPrefix(prefix, options);
    },
  };
  await search('organizzazionix', { store: counting, stemLanguages: ['en', 'es', 'pt', 'de', 'fr', 'it', 'nl'] });
  assert.ok(calls.length > 0);
  assert.equal(new Set(calls).size, calls.length, calls.join(' | '));
});
