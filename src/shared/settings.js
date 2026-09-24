import { DEFAULTS } from './constants.js';
import { MODE, normaliseRule } from '../core/capture-policy.js';
import { rulesFor } from './presets.js';
import { STEM_LANGUAGES, defaultStemLanguages } from '../core/stemming.js';

// Settings live in chrome.storage.local rather than in IndexedDB, because the
// service worker needs them cheaply at startup and they must survive even if
// the database ever has to be rebuilt.

export const SETTINGS_DEFAULTS = {
  setupComplete: false,
  mode: MODE.BROAD,
  allowlist: [],
  customRules: [],
  presets: {
    webmail: true,
    messaging: true,
    aiChats: true,
    accounts: true,
    banking: true,
    health: true,
    adult: true,
    dating: true,
    government: true,
    intranet: true,
    workTools: true,
    searchResults: true,
  },
  retentionMonths: DEFAULTS.retentionMonths,
  sizeCapBytes: DEFAULTS.sizeCapBytes,
  pausedUntil: 0,
  warnedAtFraction: 0,
  // The browser's own languages, not every supported one. The fallback
  // only runs on a term that already found nothing, but each enabled
  // language is one more bounded scan on exactly that term, and a language
  // somebody does not read is a scan that can only ever find the wrong
  // family. Setup asks, starting from this; settings can change it later.
  stemLanguages: defaultStemLanguages(globalThis.navigator && globalThis.navigator.languages),
};

const isPlainObject = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const stringList = (value) =>
  Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
    : [];

// Rules and allowlist entries are stored the way they are matched, so what
// settings shows back is what is actually applied. See normaliseRule.
const ruleList = (value) => [...new Set(stringList(value).map(normaliseRule).filter(Boolean))];

const number = (value, fallback, { min = 0 } = {}) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
};

// An array is kept as given, even empty -- someone turning off every
// language on purpose is different from the setting never having been
// written at all, and only the second case should fall back to the
// default. Anything not shaped like an array is the second case.
const stemLanguageList = (value) => {
  if (!Array.isArray(value)) return [...SETTINGS_DEFAULTS.stemLanguages];
  const known = new Set(STEM_LANGUAGES);
  return [...new Set(value.filter((entry) => known.has(entry)))];
};

// Storage can hand back something that is not settings at all. A profile
// copied between machines, a half written value, an older build's shape, or
// an extension that was interrupted mid save: the object is simply not there
// in the form the rest of the code assumes.
//
// This matters far more than it looks. `retentionMonths` arriving as null
// made the retention cutoff "now", which expired every page in the archive on
// the next hourly sweep. A settings file being slightly wrong must never be
// able to delete somebody's year of reading, so every field is checked here
// rather than trusted at the point of use.
export function normaliseSettings(raw) {
  const stored = isPlainObject(raw) ? raw : {};
  const presets = isPlainObject(stored.presets) ? stored.presets : {};

  return {
    ...SETTINGS_DEFAULTS,
    ...stored,
    setupComplete: stored.setupComplete === true,
    mode: stored.mode === MODE.STRICT ? MODE.STRICT : MODE.BROAD,
    allowlist: ruleList(stored.allowlist),
    customRules: ruleList(stored.customRules),
    presets: Object.fromEntries(
      Object.keys(SETTINGS_DEFAULTS.presets).map((key) => [
        key,
        key in presets ? !!presets[key] : SETTINGS_DEFAULTS.presets[key],
      ])
    ),
    // A retention of zero would mean "expire everything", which nobody has
    // ever wanted and which no interface offers, so it falls back rather than
    // being honoured.
    retentionMonths: number(stored.retentionMonths, SETTINGS_DEFAULTS.retentionMonths, { min: 1 }),
    sizeCapBytes: number(stored.sizeCapBytes, SETTINGS_DEFAULTS.sizeCapBytes, { min: 1 }),
    pausedUntil: number(stored.pausedUntil, 0),
    warnedAtFraction: number(stored.warnedAtFraction, 0),
    stemLanguages: stemLanguageList(stored.stemLanguages),
  };
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get('settings').catch(() => ({}));
  return normaliseSettings(stored && stored.settings);
}

// Saves are applied one at a time, each against what the last one left.
// Two changes arriving together -- two categories ticked in quick
// succession, or "never keep this site" while settings is open -- would
// otherwise both read the same starting point and the second would quietly
// undo the first.
let saving = Promise.resolve();

// `change` gets the current settings and returns the fields to change.
export function updateSettings(change) {
  const run = async () => {
    const current = await loadSettings();
    const patch = await change(current);
    const plain = isPlainObject(patch) ? patch : {};
    // Presets are merged per category, so a patch that names one category
    // cannot reset the others to whatever the sender last saw.
    const presets = isPlainObject(plain.presets)
      ? { ...current.presets, ...plain.presets }
      : current.presets;
    const next = normaliseSettings({ ...current, ...plain, presets });
    await chrome.storage.local.set({ settings: next });
    return next;
  };
  const result = saving.then(run, run);
  saving = result.catch(() => {});
  return result;
}

export const saveSettings = (patch) => updateSettings(() => patch);

export const isPaused = (settings, now = Date.now()) => settings.pausedUntil > now;

// What the capture policy needs from settings, in one place, so that no
// caller can forget a field. Every decision the extension makes about a page
// goes through this; `extra` carries what only the caller knows.
export const policyInput = (settings, extra = {}) => ({
  mode: settings.mode,
  allowlist: settings.allowlist,
  rules: rulesFor(settings.presets, settings.customRules),
  paused: isPaused(settings),
  setupComplete: settings.setupComplete === true,
  hasPasswordField: false,
  incognito: false,
  ...extra,
});

// What the sweep knows about itself between runs: when it last ran, and
// whether the size cap turned out to be one it cannot meet. Kept beside the
// settings rather than in the database, because the sweep has to be able to
// read it before deciding whether to open the archive at all.
export async function loadSweepState() {
  const stored = await chrome.storage.local.get('sweepState').catch(() => ({}));
  const state = isPlainObject(stored && stored.sweepState) ? stored.sweepState : {};
  return {
    lastSweepAt: number(state.lastSweepAt, 0),
    capUnmeetable: state.capUnmeetable === true,
    clockProblem: typeof state.clockProblem === 'string' ? state.clockProblem : null,
    clockHoldUntil: number(state.clockHoldUntil, 0),
  };
}

export async function saveSweepState(patch) {
  const current = await loadSweepState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ sweepState: next });
  return next;
}
