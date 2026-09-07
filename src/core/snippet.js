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
  let best = { start: hits[0], score: -1, end: hits[0] };
  for (const startHit of hits) {
    const windowEnd = startHit + windowTokens;
    const distinct = new Set();
    let count = 0;
    let lastHit = startHit;
    for (const h of hits) {
      if (h < startHit || h > windowEnd) continue;
      distinct.add(tokens[h].term);
      count += 1;
      lastHit = h;
    }
    const score = distinct.size * 1000 + count;
    if (score > best.score) best = { start: startHit, end: lastHit, score };
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

  let out = text.slice(from, to).trim();
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
