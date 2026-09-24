import { foldTerm } from './tokenizer.js';
import { normaliseRule } from './capture-policy.js';

// Dates are accepted as a year, a month (YYYY-MM), a day (YYYY-MM-DD), or a
// plain number of days, so "after:30" means the last month without anyone
// counting back to a date. A four digit number is a year: "after:2024" read
// as two thousand days ago was a search quietly answering something else.
// Dates are the person's own midnight, not London's, which is what
// Date.parse would make of a bare YYYY-MM-DD.
export function parseWhen(value, now = Date.now()) {
  const text = String(value || '');
  let m = text.match(/^(\d{4})$/);
  if (m && Number(m[1]) >= 1970) return new Date(Number(m[1]), 0, 1).getTime();
  if (/^\d+$/.test(text)) return now - Number(text) * 86400000;
  m = text.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (m) {
    const date = new Date(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  const parsed = Date.parse(text);
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
    const words = phrase.match(/[\p{L}\p{N}]+/gu) || [];
    if (words.length) phrases.push(words.map(foldTerm));
    return ' ';
  });

  for (const token of rest.split(/\s+/)) {
    if (!token) continue;
    const lower = token.toLowerCase();
    if (lower.startsWith('site:')) {
      // "site:https://www.example.com/page" means example.com, the same way a
      // rule typed like that does.
      site = normaliseRule(token.slice(5)).split('/')[0] || null;
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
