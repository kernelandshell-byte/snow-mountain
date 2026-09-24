import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variantsOf } from '../src/core/morphology.js';

test('offers the singular of a regular plural', () => {
  assert.deepEqual(variantsOf('charts'), ['chart']);
  assert.deepEqual(variantsOf('retros'), ['retro']);
});

test('offers both readings of an -es plural', () => {
  assert.deepEqual(variantsOf('boxes'), ['box', 'boxe']);
});

test('leaves words ending in double s alone', () => {
  assert.deepEqual(variantsOf('glass'), []);
  assert.deepEqual(variantsOf('business'), []);
});

test('leaves short words alone, where trimming is usually wrong', () => {
  assert.deepEqual(variantsOf('gas'), []);
  assert.deepEqual(variantsOf('is'), []);
});

test('leaves words that do not end in s alone', () => {
  assert.deepEqual(variantsOf('chart'), []);
  assert.deepEqual(variantsOf('münchen'), []);
});
