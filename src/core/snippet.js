// The snippet is what makes a result recognisable at a glance, so it picks
// the densest window of query terms rather than the first 150 characters.
//
// Character offsets are recomputed from the stored text at read time. They
// are never stored, which is why the index only keeps token positions.

import { tokenize } from './tokenizer.js';

export function buildSnippet(text, queryTerms, { maxChars = 260, windowTokens = 40 } = {}) {
  if (!text) return { text: '', ranges: [] };
  const wanted = new Set(queryTerms);
  const tokens = tokenize(text);
  const hits = [];
  for (let i = 0; i < tokens.length; i++) {
    if (wanted.has(tokens[i].term)) hits.push(i);
  }

  if (hits.length === 0) {
    const head = text.slice(0, maxChars).trim();
    return { text: head + (text.length > maxChars ? '…' : ''), ranges: [] };
  }

  // Slide a token window over the hits, preferring distinct terms covered,
  // then raw hit count. Ties go to the earliest window.
  //
  // Two pointers rather than a hit-by-hit rescan: `hits` is already sorted
  // (tokens are visited in order), so as the window's left edge advances,
  // its right edge only ever moves forward too. A page whose text is one
  // word repeated many thousands of times, well within MAX_TEXT_BYTES,
  // otherwise turns this into a hits x hits scan run once per search result.
  let best = { start: hits[0], score: -1, end: hits[0] };
  let right = 0;
  const counts = new Map();
  let distinctCount = 0;
  let windowSize = 0;
  for (let left = 0; left < hits.length; left++) {
    if (right < left) right = left;
    while (right < hits.length && hits[right] <= hits[left] + windowTokens) {
      const term = tokens[hits[right]].term;
      const next = (counts.get(term) || 0) + 1;
      counts.set(term, next);
      if (next === 1) distinctCount += 1;
      windowSize += 1;
      right += 1;
    }

    const score = distinctCount * 1000 + windowSize;
    if (score > best.score) best = { start: hits[left], end: hits[right - 1], score };

    const leftTerm = tokens[hits[left]].term;
    const remaining = counts.get(leftTerm) - 1;
    if (remaining === 0) {
      counts.delete(leftTerm);
      distinctCount -= 1;
    } else {
      counts.set(leftTerm, remaining);
    }
    windowSize -= 1;
  }

  const firstToken = Math.max(0, best.start - 8);
  const lastToken = Math.min(tokens.length - 1, best.end + 8);
  let from = tokens[firstToken].start;
  let to = tokens[lastToken].end;

  // Expand outward to sentence boundaries when they are close by.
  const backWindow = text.slice(Math.max(0, from - 120), from);
  const boundary = backWindow.lastIndexOf('. ');
  if (boundary !== -1) from = Math.max(0, from - 120) + boundary + 2;

  const forwardWindow = text.slice(to, to + 120);
  const stop = forwardWindow.indexOf('. ');
  if (stop !== -1) to = to + stop + 1;

  if (to - from > maxChars) to = from + maxChars;

  // Trimmed by moving the bounds rather than the string, so the ranges below
  // still count from the first character shown. A passage that starts after
  // ". \n" used to lose its leading whitespace here and every highlight, and
  // the quote a result opens with, landed a few characters to the right.
  const raw = text.slice(from, to);
  from += raw.length - raw.trimStart().length;
  to -= raw.length - raw.trimEnd().length;
  let out = text.slice(from, to);
  const ranges = [];
  for (let i = firstToken; i <= lastToken; i++) {
    const t = tokens[i];
    if (!wanted.has(t.term)) continue;
    if (t.start < from || t.end > to) continue;
    ranges.push([t.start - from, t.end - from]);
  }

  if (from > 0) out = '…' + out;
  // An ellipsis after a full stop reads as a typo. The sentence ended; that
  // is already the signal that the snippet stopped somewhere sensible.
  if (to < text.length && !/[.!?]$/.test(out)) out = out + '…';
  const shift = from > 0 ? 1 : 0;

  return { text: out, ranges: ranges.map(([a, b]) => [a + shift, b + shift]) };
}
