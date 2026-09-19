import { foldTerm } from './tokenizer.js';

// Dates are accepted as YYYY-MM-DD, or as a plain number of days, so
// "after:30" means the last month without anyone counting back to a date.
function parseWhen(value) {
  if (/^\d+$/.test(value)) return Date.now() - Number(value) * 86400000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Supports bare terms, "quoted phrases", site:, before:/after: and -word.
export function parseQuery(input) {
  const raw = String(input || '');
  const phrases = [];
  const bare = [];
  const exclude = [];
  let site = null;
  let after = null;
  let before = null;

  const rest = raw.replace(/"([^"]+)"/g, (_, phrase) => {
    const words = phrase.split(/[\p{L}\p{N}]*[^\p{L}\p{N}]+/u).length
      ? phrase.match(/[\p{L}\p{N}]+/gu) || []
      : [];
    if (words.length) phrases.push(words.map(foldTerm));
    return ' ';
  });

  for (const token of rest.split(/\s+/)) {
    if (!token) continue;
    const lower = token.toLowerCase();
    if (lower.startsWith('site:')) {
      site = token.slice(5).toLowerCase().replace(/^www\./, '') || null;
      continue;
    }
    if (lower.startsWith('after:')) {
      after = parseWhen(token.slice(6));
      continue;
    }
    if (lower.startsWith('before:')) {
      before = parseWhen(token.slice(7));
      continue;
    }
    // A leading hyphen excludes a word, the way most search engines already
    // work. Only a bare word: excluding a phrase would mean checking that no
    // position in the page carries it, which is a different, bigger feature.
    if (token.startsWith('-') && token.length > 1) {
      const words = token.slice(1).match(/[\p{L}\p{N}]+/gu) || [];
      for (const w of words) exclude.push(foldTerm(w));
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
    exclude: [...new Set(exclude)],
    site,
    after,
    before,
    // Every term the index has to look up, phrases included.
    lookup: [...new Set(all)],
    isEmpty: all.length === 0,
  };
}
