import { foldTerm } from './tokenizer.js';

// Dates are accepted as YYYY-MM-DD, or as a plain number of days, so
// "after:30" means the last month without anyone counting back to a date.
function parseWhen(value) {
  if (/^\d+$/.test(value)) return Date.now() - Number(value) * 86400000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// Supports bare terms, "quoted phrases", site: and before:/after:.
export function parseQuery(input) {
  const raw = String(input || '');
  const phrases = [];
  const bare = [];
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
    const words = token.match(/[\p{L}\p{N}]+/gu) || [];
    for (const w of words) bare.push(foldTerm(w));
  }

  const all = [...bare];
  for (const p of phrases) all.push(...p);

  return {
    terms: bare,
    phrases,
    site,
    after,
    before,
    // Every term the index has to look up, phrases included.
    lookup: [...new Set(all)],
    isEmpty: all.length === 0,
  };
}
