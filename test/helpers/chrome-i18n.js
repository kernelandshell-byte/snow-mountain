// A stand-in for chrome.i18n, for tests that run in Node. It follows what
// Chrome does with a message file, so a test of translated text is a test of
// the same lookups the extension makes:
//
//   - the user's locale first (pt_BR), then its language (pt), then the
//     default locale (en), a message at a time
//   - named placeholders ($name$) filled from $1..$9, and $$ for a dollar
//
// Loaded for every test with `node --import`. A test that wants another
// language calls setLocale('de') and puts it back afterwards.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cache = new Map();

export function loadLocale(code) {
  if (!cache.has(code)) {
    const file = path.join(root, '_locales', code, 'messages.json');
    cache.set(code, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
  }
  return cache.get(code);
}

let locale = 'en';
export const setLocale = (code) => { locale = code; };
export const currentLocale = () => locale;

function lookup(key) {
  const language = locale.split('_')[0];
  for (const code of [locale, language, 'en']) {
    const table = loadLocale(code);
    if (table && table[key] && typeof table[key].message === 'string') return table[key];
  }
  return null;
}

export function getMessage(key, substitutions) {
  if (key === '@@ui_locale') return locale;
  if (key === '@@bidi_dir') return 'ltr';
  const entry = lookup(key);
  if (!entry) return '';
  const given = Array.isArray(substitutions) ? substitutions : substitutions === undefined ? [] : [substitutions];
  const placeholders = {};
  for (const [name, spec] of Object.entries(entry.placeholders || {})) placeholders[name.toLowerCase()] = spec.content;
  return entry.message.replace(/\$([A-Za-z0-9_@]+)\$|\$\$/g, (whole, name) => {
    if (whole === '$$') return '$';
    const content = placeholders[name.toLowerCase()];
    if (content === undefined) return whole;
    return content.replace(/\$([1-9])/g, (_, n) => (given[Number(n) - 1] === undefined ? '' : given[Number(n) - 1]));
  });
}

globalThis.chrome = globalThis.chrome || {};
globalThis.chrome.i18n = {
  getMessage,
  getUILanguage: () => locale.replace('_', '-'),
};
