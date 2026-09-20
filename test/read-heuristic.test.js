import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRead } from '../src/core/read-heuristic.js';

test('a page glanced at for two seconds is not read', () => {
  assert.equal(isRead({ focusedMs: 2000, scrollDepth: 0.9, wordCount: 2000 }), false);
});

test('a long page with no scrolling is not read', () => {
  assert.equal(isRead({ focusedMs: 30000, scrollDepth: 0.05, wordCount: 3000 }), false);
});

test('a long page that was scrolled is read', () => {
  assert.equal(isRead({ focusedMs: 30000, scrollDepth: 0.6, wordCount: 3000 }), true);
});

test('a short page needs no scrolling, because there was none to do', () => {
  assert.equal(isRead({ focusedMs: 12000, scrollDepth: 0, wordCount: 120 }), true);
});

test('a pdf needs no scrolling either, because there is no such signal at all', () => {
  assert.equal(isRead({ focusedMs: 12000, scrollDepth: 0, wordCount: 0, isPdf: true }), true);
});

test('a pdf still has to clear the dwell floor', () => {
  assert.equal(isRead({ focusedMs: 2000, scrollDepth: 0, wordCount: 0, isPdf: true }), false);
});

test('a pdf with wordCount 0 is not treated as a short html page', () => {
  // wordCount 0 fails the short-page check's `> 0`, so a pdf's dwell-only
  // behaviour has to come from the explicit isPdf branch, not this one.
  assert.equal(isRead({ focusedMs: 12000, scrollDepth: 0, wordCount: 0, isPdf: false }), false);
});
