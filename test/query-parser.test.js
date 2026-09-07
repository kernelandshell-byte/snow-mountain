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

test('reads a date range written as dates', () => {
  const q = parseQuery('churn after:2026-01-01 before:2026-06-30');
  assert.equal(new Date(q.after).getUTCFullYear(), 2026);
  assert.ok(q.before > q.after);
  assert.deepEqual(q.terms, ['churn']);
});

test('accepts a plain number of days, so nobody counts back to a date', () => {
  const q = parseQuery('churn after:30');
  const days = Math.round((Date.now() - q.after) / 86400000);
  assert.equal(days, 30);
});

test('a date that makes no sense is ignored rather than breaking the query', () => {
  const q = parseQuery('churn after:soonish');
  assert.equal(q.after, null);
  assert.deepEqual(q.terms, ['churn']);
});
