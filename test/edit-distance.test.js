import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withinEditDistance } from '../src/core/edit-distance.js';

test('the same word is always within budget', () => {
  assert.equal(withinEditDistance('world', 'world', 0), true);
});

test('a single substitution is one edit away', () => {
  assert.equal(withinEditDistance('world', 'worla', 1), true);
  assert.equal(withinEditDistance('world', 'worla', 0), false);
});

test('a single insertion or deletion is one edit away', () => {
  assert.equal(withinEditDistance('world', 'worlds', 1), true);
  assert.equal(withinEditDistance('world', 'wold', 1), true);
});

test('a transposition is two edits, not one, under plain Levenshtein', () => {
  assert.equal(withinEditDistance('form', 'from', 1), false);
  assert.equal(withinEditDistance('form', 'from', 2), true);
});

test('rejects a word too far away within the given budget', () => {
  assert.equal(withinEditDistance('world', 'banana', 2), false);
});

test('a length gap larger than the budget is rejected without scoring', () => {
  assert.equal(withinEditDistance('cat', 'category', 2), false);
});
