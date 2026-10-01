// Localisation, on top of chrome.i18n.
//
// Every string a person can read lives in _locales/<code>/messages.json, which
// is also what lets Chrome and the Web Store see which languages the
// extension speaks. This file is the thin layer the interface code uses.
//
//   t('key', a, b)        one message; a and b fill $1 and $2 in its order
//   tn('pages', 3)        a plural: picks pages_one or pages_other for the
//                         language, and fills $1 with the formatted count
//   rich(el, 'key', ...)  a message that carries <kbd>, <code>, <strong> or
//                         <em>, put into an element without ever treating a
//                         translation as HTML
//   translatePage()       fills in everything marked data-i18n in the page
//   languageName('de')    a language's name in the language of the interface
//
// A message is never built by joining pieces of English. Word order, plurals
// and punctuation differ, so each sentence is one message and the dynamic
// parts are placeholders inside it.

const api = () => (typeof chrome !== 'undefined' && chrome.i18n) || null;

export function uiLanguage() {
  const i18n = api();
  const language = i18n && i18n.getUILanguage ? i18n.getUILanguage() : 'en';
  return language || 'en';
}

// Extension locales use an underscore (pt_BR); everything else a hyphen.
const bcp47 = () => uiLanguage().replace('_', '-');

export function t(key, ...substitutions) {
  const i18n = api();
  if (!i18n) return key;
  const flat = substitutions.length === 1 && Array.isArray(substitutions[0]) ? substitutions[0] : substitutions;
  const message = i18n.getMessage(key, flat.map((value) => String(value)));
  // A missing message comes back empty. Showing the key makes the gap obvious
  // on screen and in tests, where an empty label would just look broken.
  return message === '' || message === undefined ? key : message;
}

const ruleCache = new Map();
// The plural category for a count, in the language of the interface. Only
// "one" and "other" are written: that is every category the supported
// languages need for ordinary counts, and anything else reads as "other".
export function plural(count) {
  try {
    const language = bcp47();
    if (!ruleCache.has(language)) ruleCache.set(language, new Intl.PluralRules(language));
    return ruleCache.get(language).select(count) === 'one' ? 'one' : 'other';
  } catch {
    return count === 1 ? 'one' : 'other';
  }
}

export function formatNumber(value) {
  try {
    return Number(value).toLocaleString(bcp47());
  } catch {
    return String(value);
  }
}

// tn('pages', 1200) -> pages_other with $1 = "1,200". Further arguments fill
// $2 onwards.
export function tn(base, count, ...more) {
  return t(base + '_' + plural(count), formatNumber(count), ...more);
}

// "A and B", "A, B and C": a list joined the way the language does it.
export function listAnd(items) {
  try {
    return new Intl.ListFormat(bcp47(), { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

export function languageName(code, fallback = code) {
  try {
    const names = new Intl.DisplayNames([bcp47()], { type: 'language' });
    const name = names.of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(bcp47()) + name.slice(1);
  } catch {
    // Older engines, or a code it does not know.
  }
  return fallback;
}

const ALLOWED = new Set(['kbd', 'code', 'strong', 'em']);

// Puts a message into an element. Plain text goes in as text. A message that
// contains <kbd>, <code>, <strong> or <em> gets those as elements; every other
// character, including any other tag, stays text. A translation is therefore
// never able to put anything else on the page, whatever it contains.
export function setRich(element, message) {
  element.textContent = '';
  const pattern = /<(kbd|code|strong|em)>([\s\S]*?)<\/\1>/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(message)) !== null) {
    if (match.index > last) element.append(message.slice(last, match.index));
    if (ALLOWED.has(match[1])) {
      const child = document.createElement(match[1]);
      child.textContent = match[2];
      element.append(child);
    }
    last = match.index + match[0].length;
  }
  if (last < message.length) element.append(message.slice(last));
}

// The same rule as setRich, for the few places that assemble a string of HTML:
// everything is escaped, then only the four tags above are let back in.
export function safeHtml(message) {
  const escaped = String(message).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return escaped.replace(/&lt;(kbd|code|strong|em)&gt;([\s\S]*?)&lt;\/\1&gt;/g, '<$1>$2</$1>');
}

export function rich(element, key, ...substitutions) {
  setRich(element, t(key, ...substitutions));
  return element;
}

// Static text in the HTML is marked rather than written in script, so a page
// reads as a page. data-i18n sets the content, and the attribute forms set
// the matching attribute:
//
//   <h1 data-i18n="setup_step0_title">A memory for your browser</h1>
//   <input data-i18n-placeholder="x" data-i18n-aria-label="y" data-i18n-title="z">
//
// The English left in the HTML is what shows if a message is ever missing
// from every language, and what a search engine or a person reading the
// source sees.
const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];

export function translatePage(root = document) {
  const i18n = api();
  if (!i18n) return;
  document.documentElement.lang = uiLanguage().replace('_', '-');
  document.documentElement.dir = t('@@bidi_dir') === 'rtl' ? 'rtl' : 'ltr';
  for (const element of root.querySelectorAll('[data-i18n]')) {
    const message = i18n.getMessage(element.dataset.i18n);
    if (message) setRich(element, message);
  }
  for (const attribute of ATTRIBUTES) {
    for (const element of root.querySelectorAll('[data-i18n-' + attribute + ']')) {
      const message = i18n.getMessage(element.getAttribute('data-i18n-' + attribute));
      if (message) element.setAttribute(attribute, message);
    }
  }
}
