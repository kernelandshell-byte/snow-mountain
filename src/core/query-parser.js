import { foldTerm } from './tokenizer.js';

// Supports bare terms, "quoted phrases" and site: filters.
// Date filters can wait until there is a reason to want them.
export function parseQuery(input) {
  const raw = String(input || '');
  const phrases = [];
  const bare = [];
  let site = null;

  const rest = raw.replace(/"([^"]+)"/g, (_, phrase) => {
    const words = phrase.split(/[\p{L}\p{N}]*[^\p{L}\p{N}]+/u).length
      ? phrase.match(/[\p{L}\p{N}]+/gu) || []
      : [];
    if (words.length) phrases.push(words.map(foldTerm));
    return ' ';
  });

  for (const token of rest.split(/\s+/)) {
    if (!token) continue;
    if (token.toLowerCase().startsWith('site:')) {
      site = token.slice(5).toLowerCase().replace(/^www\./, '') || null;
      continue;
    }
    const words = token.match(/[\p{L}\p{N}]+/gu) || [];
    for (const w of words) bare.push(foldTerm(w));
  }

  const all = [...bare];
  for (const p of phrases) all.push(...p);

  return {
    terms: bare,
    phrases,
    site,
    // Every term the index has to look up, phrases included.
    lookup: [...new Set(all)],
    isEmpty: all.length === 0,
  };
}
