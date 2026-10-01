// The localisation has three ways to go wrong without anybody noticing until a
// person in another country does: the code asks for a message that is not
// there (they see a raw key), a language drops or invents a message, or a
// translation loses a placeholder (they see "$count$" or a blank). All three
// are cheap to catch here, for every language at once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = path.join(root, '_locales');
const read = (file) => readFileSync(file, 'utf8');
const messages = (code) => JSON.parse(read(path.join(localesDir, code, 'messages.json')));
const codes = readdirSync(localesDir).filter((name) => statSync(path.join(localesDir, name)).isDirectory()).sort();
const en = messages('en');

// What the search offers, and so what the interface speaks.
const EXPECTED = ['de', 'en', 'es', 'fr', 'it', 'nl', 'pt_BR', 'pt_PT'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === 'vendor') continue;
    // The helper's own comments quote example keys.
    if (name === 'i18n.js') continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|html)$/.test(name)) out.push(full);
  }
  return out;
}

// Every message key the code and the markup can ask for.
const literals = new Set();
function keysInUse() {
  const used = new Set();
  const dynamic = [];
  for (const file of walk(path.join(root, 'src'))) {
    const text = read(file);
    for (const match of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'\s*[,)]/g)) used.add(match[1]);
    for (const match of text.matchAll(/'([a-z]+_[A-Za-z0-9_]+)'/g)) literals.add(match[1]);
    for (const match of text.matchAll(/\btn\(\s*'([A-Za-z0-9_]+)'/g)) { used.add(match[1] + '_one'); used.add(match[1] + '_other'); }
    for (const match of text.matchAll(/\brich\([^,]+,\s*'([A-Za-z0-9_]+)'/g)) used.add(match[1]);
    for (const match of text.matchAll(/emptyState\(\s*'([A-Za-z0-9_]+)'\s*,\s*'([A-Za-z0-9_]+)'/g)) { used.add(match[1]); used.add(match[2]); }
    for (const match of text.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) used.add(match[1]);
    for (const match of text.matchAll(/'((?:reason|opt_clock)_[a-z_]+)'/g)) used.add(match[1]);
    for (const match of text.matchAll(/'((?:opt_log|picker)_[a-z_]+)'/g)) used.add(match[1]);
    for (const match of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+_)'\s*\+/g)) dynamic.push(match[1]);
  }
  for (const match of read(path.join(root, 'manifest.json')).matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(match[1]);
  const presets = Object.keys(en).filter((key) => /^preset_.+_title$/.test(key)).map((key) => key.slice(7, -6));
  for (const name of presets) for (const part of ['title', 'example', 'lower']) used.add('preset_' + name + '_' + part);
  for (const prefix of ['opt_newcat_', 'opt_rules_match_']) { used.add(prefix + 'one'); used.add(prefix + 'other'); }
  return { used, dynamic };
}

const placeholdersOf = (entry) => Object.keys(entry.placeholders || {}).sort();
const tokensIn = (text) => [...new Set([...text.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase()))].sort();

test('the interface speaks every language the search does', () => {
  assert.deepEqual(codes, EXPECTED);
  const manifest = JSON.parse(read(path.join(root, 'manifest.json')));
  assert.equal(manifest.default_locale, 'en');
});

test('everything the code asks for exists in the default language', () => {
  const { used, dynamic } = keysInUse();
  const missing = [...used].filter((key) => !en[key]);
  assert.deepEqual(missing, [], 'asked for but not defined: ' + missing.join(', '));
  for (const prefix of dynamic) {
    assert.ok(Object.keys(en).some((key) => key.startsWith(prefix)), 'nothing defined for the family ' + prefix + '...');
  }
});

test('nothing is defined that nothing uses', () => {
  const { used } = keysInUse();
  // A key picked by a ternary or a table is still a quoted word in the source.
  const unused = Object.keys(en).filter((key) => !used.has(key) && !literals.has(key));
  assert.deepEqual(unused, [], 'defined but never used: ' + unused.join(', '));
});

test('every language has exactly the messages the default has', () => {
  for (const code of codes) {
    const own = messages(code);
    assert.deepEqual(Object.keys(own).sort(), Object.keys(en).sort(), code);
  }
});

test('every message says something, and keeps the placeholders it was given', () => {
  for (const code of codes) {
    const own = messages(code);
    for (const [key, entry] of Object.entries(own)) {
      assert.ok(typeof entry.message === 'string' && entry.message.trim(), `${code}/${key}: empty`);
      assert.deepEqual(placeholdersOf(entry), placeholdersOf(en[key]), `${code}/${key}: placeholder list differs`);
      for (const [name, spec] of Object.entries(entry.placeholders || {})) {
        assert.equal(spec.content, en[key].placeholders[name].content, `${code}/${key}: $${name}$ points at a different value`);
      }
      assert.deepEqual(tokensIn(entry.message), placeholdersOf(en[key]).map((n) => n.toLowerCase()).sort(), `${code}/${key}: the text uses different placeholders than it declares`);
    }
  }
});

test('plural messages come in pairs', () => {
  const bases = new Set(Object.keys(en).filter((k) => /_(one|other)$/.test(k)).map((k) => k.replace(/_(one|other)$/, '')));
  for (const base of bases) {
    assert.ok(en[base + '_one'] && en[base + '_other'], 'missing half of ' + base);
  }
});

test('markup in a message is only the four tags the interface knows how to show', () => {
  for (const code of codes) {
    for (const [key, entry] of Object.entries(messages(code))) {
      const stripped = entry.message.replace(/<\/?(kbd|code|strong|em)>/g, '');
      assert.ok(!/[<>]/.test(stripped), `${code}/${key}: unexpected markup`);
      // Tags have to balance, or the renderer shows a stray angle bracket.
      for (const tag of ['kbd', 'code', 'strong', 'em']) {
        const opens = (entry.message.match(new RegExp('<' + tag + '>', 'g')) || []).length;
        const closes = (entry.message.match(new RegExp('</' + tag + '>', 'g')) || []).length;
        assert.equal(opens, closes, `${code}/${key}: <${tag}> is not closed`);
      }
    }
  }
  // The same tags, in the same places, in every language.
  for (const code of codes) {
    for (const [key, entry] of Object.entries(messages(code))) {
      const tags = (text) => (text.match(/<\/?(kbd|code|strong|em)>/g) || []).sort().join('');
      assert.equal(tags(entry.message), tags(en[key].message), `${code}/${key}: tags differ from the default`);
    }
  }
});

test('the store sees the right name and a description that fits', () => {
  for (const code of codes) {
    const own = messages(code);
    assert.equal(own.extName.message, 'TextMemory', code);
    assert.ok(own.extDescription.message.length <= 132, `${code}: description is ${own.extDescription.message.length} characters`);
    assert.ok(own.cmdOpenSearch.message.length > 0);
  }
});

test('the product name is never translated or lost inside a message', () => {
  for (const code of codes) {
    for (const [key, entry] of Object.entries(messages(code))) {
      if (/textmemory/i.test(en[key].message)) {
        assert.ok(entry.message.includes('TextMemory'), `${code}/${key}: the name is missing`);
      }
    }
  }
});

test('the manifest file only points at messages that exist', () => {
  assert.ok(existsSync(path.join(localesDir, 'en', 'messages.json')));
});
