import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSettings, SETTINGS_DEFAULTS } from '../src/shared/settings.js';
import { STEM_LANGUAGES, defaultStemLanguages } from '../src/core/stemming.js';

test("defaults to the browser's own languages, not every supported one", () => {
  const expected = defaultStemLanguages(globalThis.navigator && globalThis.navigator.languages);
  assert.deepEqual(SETTINGS_DEFAULTS.stemLanguages, expected);
  assert.deepEqual(normaliseSettings({}).stemLanguages, expected);
  assert.ok(expected.length > 0 && expected.length < STEM_LANGUAGES.length);
});

test('an archive set up before the language list grew keeps what it had', () => {
  // Stored settings are written in full, so somebody who set up with the
  // original three still has all three, Dutch included.
  assert.deepEqual(normaliseSettings({ stemLanguages: ['en', 'de', 'nl'] }).stemLanguages, ['en', 'de', 'nl']);
});

test('keeps a chosen subset, in no particular order', () => {
  assert.deepEqual(normaliseSettings({ stemLanguages: ['nl'] }).stemLanguages, ['nl']);
});

test('an intentionally empty list stays empty rather than falling back', () => {
  assert.deepEqual(normaliseSettings({ stemLanguages: [] }).stemLanguages, []);
});

test('drops anything that is not a language this build supports', () => {
  assert.deepEqual(normaliseSettings({ stemLanguages: ['en', 'ru', 'en'] }).stemLanguages, ['en']);
  assert.deepEqual(normaliseSettings({ stemLanguages: ['__proto__', 'porter', 'fr'] }).stemLanguages, ['fr']);
});

test('a value that is not an array falls back to the default', () => {
  assert.deepEqual(normaliseSettings({ stemLanguages: 'en' }).stemLanguages, SETTINGS_DEFAULTS.stemLanguages);
  assert.deepEqual(normaliseSettings({ stemLanguages: null }).stemLanguages, SETTINGS_DEFAULTS.stemLanguages);
});

import { policyInput } from '../src/shared/settings.js';

test('rules and allowlist entries are stored the way they are matched', () => {
  const s = normaliseSettings({ customRules: ['https://www.Example.com/', 'example.com', ' '], allowlist: ['WWW.docs.example.org'] });
  assert.deepEqual(s.customRules, ['example.com']);
  assert.deepEqual(s.allowlist, ['docs.example.org']);
});

test('the policy input carries whether setup is finished, and defaults to not', () => {
  assert.equal(policyInput(normaliseSettings({})).setupComplete, false);
  assert.equal(policyInput(normaliseSettings({ setupComplete: true })).setupComplete, true);
});

test('the two new categories are on by default and survive older stored settings', () => {
  const s = normaliseSettings({ presets: { webmail: false } });
  assert.equal(s.presets.aiChats, true);
  assert.equal(s.presets.accounts, true);
  assert.equal(s.presets.webmail, false);
});

test('saves are applied one after another, and a category patch changes only that category', async () => {
  let stored = {};
  globalThis.chrome = {
    storage: { local: {
      get: async (key) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { [key]: stored[key] };
      },
      set: async (value) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        Object.assign(stored, JSON.parse(JSON.stringify(value)));
      },
    } },
  };
  const { saveSettings } = await import('../src/shared/settings.js');
  await saveSettings({ presets: { adult: false, health: false } });
  await Promise.all([
    saveSettings({ presets: { adult: true } }),
    saveSettings({ presets: { health: true } }),
    saveSettings({ customRules: ['one.example'] }),
  ]);
  assert.equal(stored.settings.presets.adult, true);
  assert.equal(stored.settings.presets.health, true);
  assert.deepEqual(stored.settings.customRules, ['one.example']);
  delete globalThis.chrome;
});
