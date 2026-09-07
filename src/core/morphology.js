// A deliberately tiny amount of morphology.
//
// Full stemming is out, for the reason in BRIEF.md: this index serves
// English, German and Dutch, and an English stemmer damages the other two.
// But the single most common way a query misses is a plural, and that is
// cheap to handle without touching the index: if a term has no postings at
// all, try the obvious singular before giving up.
//
// Only applied as a fallback, never at index time, so nothing is conflated
// in storage and a term that really exists always wins.

export function variantsOf(term) {
  const out = [];
  if (term.length >= 5 && term.endsWith('es')) out.push(term.slice(0, -2));
  if (term.length >= 4 && term.endsWith('s') && !term.endsWith('ss')) out.push(term.slice(0, -1));
  return out;
}
