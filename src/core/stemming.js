// Language-aware stemming, same shape as the plural fallback in
// morphology.js: a term that has no postings at all gets one more cheap
// guess, this time at its stem, before search gives up on it.
//
// Query time only, never index time, so storage is untouched and a term
// that really exists always wins over a stemmed guess. Which languages to
// try is a setting, not a detection: nothing in a two or three word query
// reliably says what language it is in, and guessing wrong would silently
// widen a search to the wrong language's stems.
//
// The six offered up front are the major European languages with the most
// web content. Dutch is kept for anyone who already relies on it. Chinese,
// Japanese, Korean and Thai are not a stemming problem: they need the
// tokenizer to split words, which it does not do yet.

import English from '../vendor/snowball/english.js';
import Spanish from '../vendor/snowball/spanish.js';
import German from '../vendor/snowball/german.js';
import Dutch from '../vendor/snowball/dutch.js';
// French, Portuguese and Italian are compiled for accent-folded text, which
// is the only text that reaches a stemmer here. Unmodified, they miss about
// three in ten French and Portuguese word families, because "-ité" arrives
// as "-ite". See tools/fold-snowball.mjs.
import French from '../vendor/snowball/french-folded.js';
import Portuguese from '../vendor/snowball/portuguese-folded.js';
import Italian from '../vendor/snowball/italian-folded.js';

// Also the order they are offered in. Dutch is supported but not one of
// the six offered up front; see FEATURED_LANGUAGES.
export const STEM_LANGUAGES = ['en', 'es', 'pt', 'de', 'fr', 'it', 'nl'];

// What the language picker shows before anyone searches it. Anything else
// in STEM_LANGUAGES is still one search away, and stays shown once chosen.
export const FEATURED_LANGUAGES = ['en', 'es', 'pt', 'de', 'fr', 'it'];

export const STEM_LANGUAGE_LABELS = {
  en: 'English',
  es: 'Spanish',
  pt: 'Portuguese',
  de: 'German',
  fr: 'French',
  it: 'Italian',
  nl: 'Dutch',
};

// Each language's name for itself, so someone looking for their own
// language finds it under the name they would type.
export const STEM_LANGUAGE_NATIVE = {
  en: 'English',
  es: 'Español',
  pt: 'Português',
  de: 'Deutsch',
  fr: 'Français',
  it: 'Italiano',
  nl: 'Nederlands',
};

// One instance per language, reused across calls: stem() resets all of a
// stemmer's state from the word it is given, so nothing here leaks between
// terms and there is no reason to pay for a new object every time.
const STEMMERS = {
  en: new English(),
  es: new Spanish(),
  pt: new Portuguese(),
  de: new German(),
  fr: new French(),
  it: new Italian(),
  nl: new Dutch(),
};

export function stem(term, lang) {
  const stemmer = Object.hasOwn(STEMMERS, lang) ? STEMMERS[lang] : null;
  if (!stemmer || !term) return null;
  // The caller uses this as a prefix to scan for other terms that share
  // it, not as a direct lookup, so a term that is already its own stem
  // (most short, common words are) still has to return that stem: it is
  // exactly what makes "run" find "running".
  return stemmer.stem(term) || null;
}

// The languages someone is likely to read, from what their browser says
// they read, in the order it says it. Only a starting point: it is what
// the setup screen pre-checks and what someone who never answers ends up
// with. Falls back to English, the language most of the web is written in,
// rather than to nothing, because nothing means the fallback silently never
// runs.
export function defaultStemLanguages(browserLanguages = []) {
  const list = Array.isArray(browserLanguages) ? browserLanguages : [browserLanguages];
  const picked = [];
  for (const tag of list) {
    if (typeof tag !== 'string') continue;
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (STEM_LANGUAGES.includes(base) && !picked.includes(base)) picked.push(base);
  }
  return picked.length ? picked : ['en'];
}
