import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnippet } from '../src/core/snippet.js';

const text = [
  'Teams usually start retrospectives with enthusiasm.',
  'After a few months the meeting becomes a ritual nobody defends.',
  'Retro fatigue sets in when the same problems are raised and nothing changes.',
  'The fix is rarely a new format.',
].join(' ');

test('picks the window around the query terms, not the start of the page', () => {
  const s = buildSnippet(text, ['retro', 'fatigue']);
  assert.match(s.text, /Retro fatigue/);
});

test('highlight ranges line up with the snippet text', () => {
  const s = buildSnippet(text, ['fatigue']);
  const marked = s.ranges.map(([a, b]) => s.text.slice(a, b).toLowerCase());
  assert.ok(marked.length > 0, 'expected at least one highlight');
  for (const m of marked) assert.equal(m, 'fatigue');
});

test('falls back to the opening when nothing matches', () => {
  const s = buildSnippet(text, ['kangaroo']);
  assert.match(s.text, /^Teams usually start/);
  assert.deepEqual(s.ranges, []);
});

test('handles empty text', () => {
  assert.deepEqual(buildSnippet('', ['x']), { text: '', ranges: [] });
});

test('respects the length cap', () => {
  const long = Array(400).fill('filler words here').join(' ') + ' needle ' + Array(400).fill('more filler').join(' ');
  const s = buildSnippet(long, ['needle'], { maxChars: 200 });
  assert.ok(s.text.length <= 210, 'snippet was ' + s.text.length + ' chars');
});
