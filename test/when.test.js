import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whenText } from '../src/ui/shared/when.js';

const NOW = Date.parse('2026-09-14T12:00:00Z');
const daysAgo = (n) => NOW - n * 86400000;

test('the recent past reads as a person would say it', () => {
  assert.equal(whenText(NOW, NOW), 'today');
  assert.equal(whenText(daysAgo(1), NOW), 'yesterday');
  assert.equal(whenText(daysAgo(9), NOW), '9 days ago');
});

test('one of something is never "1 months ago"', () => {
  assert.equal(whenText(daysAgo(31), NOW), 'last month');
  assert.equal(whenText(daysAgo(365), NOW), 'last year');
});

test('and more than one still counts', () => {
  assert.equal(whenText(daysAgo(70), NOW), '2 months ago');
  assert.equal(whenText(daysAgo(800), NOW), '2 years ago');
});

test('a page dated in the future does not read as a prediction', () => {
  // What a wrong clock leaves behind. "In four months" on something you have
  // already read would be a strange thing to put in front of somebody.
  assert.equal(whenText(NOW + 120 * 86400000, NOW), 'today');
});

test('nonsense produces nothing rather than NaN', () => {
  assert.equal(whenText(undefined, NOW), '');
  assert.equal(whenText(NaN, NOW), '');
});
