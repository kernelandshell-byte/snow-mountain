import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stem, STEM_LANGUAGES, FEATURED_LANGUAGES, STEM_LANGUAGE_LABELS, STEM_LANGUAGE_NATIVE,
  defaultStemLanguages,
} from '../src/core/stemming.js';
import { foldTerm } from '../src/core/tokenizer.js';

test('lists the languages this build supports', () => {
  assert.deepEqual(STEM_LANGUAGES, ['en', 'es', 'pt', 'de', 'fr', 'it', 'nl']);
});

test('offers six up front, and Dutch only when looked for', () => {
  assert.deepEqual(FEATURED_LANGUAGES, ['en', 'es', 'pt', 'de', 'fr', 'it']);
  assert.ok(FEATURED_LANGUAGES.every((lang) => STEM_LANGUAGES.includes(lang)));
  assert.ok(!FEATURED_LANGUAGES.includes('nl'));
});

test('every language has an English name and its own name', () => {
  for (const lang of STEM_LANGUAGES) {
    assert.ok(STEM_LANGUAGE_LABELS[lang], lang);
    assert.ok(STEM_LANGUAGE_NATIVE[lang], lang);
  }
});

test('strips a regular English suffix', () => {
  assert.equal(stem('running', 'en'), 'run');
  assert.equal(stem('organization', 'en'), 'organiz');
});

test('strips a regular German suffix, on the already-folded form', () => {
  // The tokenizer folds "Häuser" to "hauser" (NFKD strips the umlaut down
  // to a plain "a") before a term ever reaches here, so that is the form
  // the stemmer has to work on.
  assert.equal(stem('hauser', 'de'), 'haus');
});

test('strips a regular Dutch suffix', () => {
  assert.equal(stem('huizen', 'nl'), 'huis');
  assert.equal(stem('lopen', 'nl'), 'loop');
});

test('a word that is already its own stem returns itself', () => {
  // This is what lets a search for "run" find a page that only contains
  // "running": the stem is used as a prefix to scan for related terms, not
  // as a direct lookup, so it has to come back even when it equals the
  // word that was typed.
  assert.equal(stem('chart', 'en'), 'chart');
});

// Each on the folded form, since that is all the index ever holds.
const family = (lang, words) => new Set(words.map((word) => stem(foldTerm(word), lang)));

test('Spanish groups a word family', () => {
  assert.equal(family('es', ['nación', 'naciones']).size, 1);
  assert.equal(family('es', ['corriendo', 'corren', 'correr']).size, 1);
});

test('Portuguese groups a family whose endings carry a tilde', () => {
  // "-ção" arrives as "-cao". The unmodified algorithm looks for the
  // accented ending and leaves the folded one alone.
  assert.equal(family('pt', ['informação', 'informações']).size, 1);
  assert.equal(family('pt', ['mudança', 'mudanças']).size, 1);
});

test('French groups a family whose endings carry an accent', () => {
  // "-ité" arrives as "-ite", "-é" as "-e".
  assert.equal(family('fr', ['généralité', 'généralités']).size, 1);
  assert.equal(family('fr', ['continuer', 'continué', 'continuée']).size, 1);
});

test('Italian groups a word family', () => {
  assert.equal(family('it', ['città', 'citta']).size, 1);
  assert.equal(family('it', ['parlare', 'parlando', 'parlato']).size, 1);
});

test('returns null for an unknown language rather than guessing one', () => {
  assert.equal(stem('running', 'ru'), null);
  assert.equal(stem('running', ''), null);
  assert.equal(stem('running', '__proto__'), null);
  assert.equal(stem('running', 'constructor'), null);
});

test("defaults to the browser's languages, in its order", () => {
  assert.deepEqual(defaultStemLanguages(['de-DE', 'de', 'en-US', 'en']), ['de', 'en']);
  assert.deepEqual(defaultStemLanguages(['pt-BR']), ['pt']);
  assert.deepEqual(defaultStemLanguages(['es_419', 'fr-CA']), ['es', 'fr']);
});

test('falls back to English rather than to nothing', () => {
  // A browser in a language with no stemmer here would otherwise end up
  // with the fallback silently switched off.
  assert.deepEqual(defaultStemLanguages(['ja-JP', 'zh']), ['en']);
  assert.deepEqual(defaultStemLanguages([]), ['en']);
  assert.deepEqual(defaultStemLanguages(undefined), ['en']);
  assert.deepEqual(defaultStemLanguages('nl-BE'), ['nl']);
  assert.deepEqual(defaultStemLanguages([null, 7, 'it']), ['it']);
});

test('returns null for an empty term', () => {
  assert.equal(stem('', 'en'), null);
});
