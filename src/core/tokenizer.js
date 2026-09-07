// Lowercase, diacritic folded, Unicode aware. No stemming: this index has
// to serve English, German and Dutch, and naive English stemming actively
// damages the other two. Prefix matching covers most of the gap.

const WORD = /[\p{L}\p{N}]+/gu;

export function foldTerm(raw) {
  return raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    // NFKD leaves the German sharp s alone, so "Straße" and "Strasse"
    // would never match each other. Fold it by hand.
    .replace(/\u00df/g, 'ss');
}

// Returns [{ term, pos, start, end }]. `pos` is the token index, used by the
// index for phrase queries. `start`/`end` are character offsets, used only at
// snippet time, and never stored.
export function tokenize(text) {
  const out = [];
  if (!text) return out;
  let pos = 0;
  for (const m of text.matchAll(WORD)) {
    const term = foldTerm(m[0]);
    if (!term) continue;
    if (term.length > 64) continue;
    out.push({ term, pos, start: m.index, end: m.index + m[0].length });
    pos += 1;
  }
  return out;
}

export function terms(text) {
  return tokenize(text).map((t) => t.term);
}
