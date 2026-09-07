// Builds the #:~:text= URL that lands a reader on the passage that matched.
//
// The spike in spikes/text-fragment settled the rules this has to respect:
// a single contiguous phrase works, ranges are not worth the fragility, a
// phrase that is no longer on the page simply opens at the top, and the
// extension can never find out which of those happened. So the job here is
// to produce the most quotable phrase available and then say nothing.

const MAX_WORDS = 10;
const MIN_WORDS = 4;

// Snippets arrive with ellipses and possibly a partial first word.
const clean = (text) => text.replace(/^[…\s]+/, '').replace(/[…\s]+$/, '');

export function phraseFrom(snippetText, ranges = []) {
  const text = clean(snippetText || '');
  if (!text) return null;

  const start = ranges.length ? Math.max(0, ranges[0][0] - (snippetText.startsWith('…') ? 1 : 0)) : 0;

  // Begin at a word boundary at or before the first match.
  let from = start;
  while (from > 0 && !/\s/.test(text[from - 1])) from -= 1;

  const rest = text.slice(from);
  // A sentence end is the most reliable place to stop, since anything
  // beyond it is likely to have been reworded independently.
  const sentenceEnd = rest.search(/[.!?]\s|[.!?]$/);
  const candidate = sentenceEnd === -1 ? rest : rest.slice(0, sentenceEnd);

  const words = candidate.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
  if (words.length < MIN_WORDS) {
    const fallback = text.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
    if (fallback.length < MIN_WORDS) return null;
    return fallback.join(' ');
  }
  return words.join(' ');
}

export function textFragmentUrl(url, snippetText, ranges = []) {
  const phrase = phraseFrom(snippetText, ranges);
  if (!phrase) return url;
  // Strip any fragment the stored URL already carries: two directives on one
  // URL is not a thing, and a stale #section would win the scroll.
  const base = url.split('#')[0];
  return base + '#:~:text=' + encodeURIComponent(phrase);
}
