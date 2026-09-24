import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, terms, foldTerm } from '../src/core/tokenizer.js';

test('folds diacritics so umlauts match their bare forms', () => {
  assert.equal(foldTerm('Über'), 'uber');
  assert.equal(foldTerm('café'), 'cafe');
});

test('folds the German sharp s', () => {
  assert.equal(foldTerm('Straße'), 'strasse');
  assert.deepEqual(terms('Straße'), terms('Strasse'));
});

test('keeps numbers and drops punctuation', () => {
  assert.deepEqual(terms('BM25, k1 = 1.2!'), ['bm25', 'k1', '1', '2']);
});

test('positions are sequential and offsets point at the source text', () => {
  const text = 'alpha beta gamma';
  const tokens = tokenize(text);
  assert.deepEqual(tokens.map((t) => t.pos), [0, 1, 2]);
  assert.equal(text.slice(tokens[1].start, tokens[1].end), 'beta');
});

test('handles empty and null input', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});
