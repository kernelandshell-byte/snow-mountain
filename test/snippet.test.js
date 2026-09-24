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

test('does not add an ellipsis straight after a full stop', () => {
  const long = 'Alpha beta gamma. The needle is here and the sentence ends. Then more text follows for a while.';
  const s = buildSnippet(long, ['needle'], { maxChars: 80 });
  assert.ok(!/\.…$/.test(s.text), 'got: ' + s.text);
});

test('still marks a truncation that lands mid sentence', () => {
  const long = 'The needle appears early ' + 'and then a great deal more text continues '.repeat(20);
  const s = buildSnippet(long, ['needle'], { maxChars: 60 });
  assert.ok(s.text.endsWith('…'), 'got: ' + s.text);
});

test('stays fast on a page that is one word repeated many thousands of times', () => {
  // A spammy page, well inside the real MAX_TEXT_BYTES capture cap, gives one
  // query term tens of thousands of hits in a single document. The window
  // search has to stay linear in the number of hits, not quadratic, or one
  // such document in a result page hangs the search for everyone.
  const text = 'spam '.repeat(40000);
  const started = Date.now();
  const s = buildSnippet(text, ['spam']);
  assert.ok(Date.now() - started < 500, 'buildSnippet took too long on a repetitive document');
  assert.match(s.text, /spam/);
});

test('highlights still line up when the passage starts after a line break', () => {
  // A sentence ending in ". " followed by a newline and indent: the snippet
  // starts after the break, and the whitespace it drops must not shift the
  // marks, or the quote a result opens with is a few letters off.
  const words = (n, w) => Array.from({ length: n }, (_, i) => w + i).join(' ');
  const text = words(30, 'alpha') + '. \n  ' + words(10, 'beta') + ' sourdough ' + words(10, 'gamma') + '.';
  const s = buildSnippet(text, ['sourdough']);
  assert.equal(s.ranges.length, 1);
  const [from, to] = s.ranges[0];
  assert.equal(s.text.slice(from, to), 'sourdough');
});
