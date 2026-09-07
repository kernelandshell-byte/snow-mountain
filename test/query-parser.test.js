import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../src/core/query-parser.js';

test('splits bare terms and folds them', () => {
  const q = parseQuery('Retro Fatigue');
  assert.deepEqual(q.terms, ['retro', 'fatigue']);
  assert.equal(q.isEmpty, false);
});

test('extracts quoted phrases and still looks their words up', () => {
  const q = parseQuery('"postings bucket" search');
  assert.deepEqual(q.phrases, [['postings', 'bucket']]);
  assert.deepEqual(q.terms, ['search']);
  assert.deepEqual(q.lookup.sort(), ['bucket', 'postings', 'search']);
});

test('reads a site filter and drops it from the terms', () => {
  const q = parseQuery('churn site:www.example.com');
  assert.equal(q.site, 'example.com');
  assert.deepEqual(q.terms, ['churn']);
});

test('an empty query is flagged rather than searched', () => {
  assert.equal(parseQuery('   ').isEmpty, true);
  assert.equal(parseQuery('').isEmpty, true);
});
