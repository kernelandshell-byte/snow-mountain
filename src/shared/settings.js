import { DEFAULTS } from './constants.js';
import { MODE } from '../core/capture-policy.js';

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
    banking: true,
    health: true,
    adult: true,
    government: true,
    intranet: true,
    searchResults: true,
  },
  retentionMonths: DEFAULTS.retentionMonths,
  sizeCapBytes: DEFAULTS.sizeCapBytes,
  pausedUntil: 0,
  warnedAtFraction: 0,
};

const isPlainObject = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const stringList = (value) =>
  Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
    : [];

const number = (value, fallback, { min = 0 } = {}) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
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
    allowlist: stringList(stored.allowlist),
    customRules: stringList(stored.customRules),
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
  };
}

export async function loadSettings() {
  const stored = await chrome.storage.local.get('settings').catch(() => ({}));
  return normaliseSettings(stored && stored.settings);
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = normaliseSettings({ ...current, ...(isPlainObject(patch) ? patch : {}) });
  await chrome.storage.local.set({ settings: next });
  return next;
}

export const isPaused = (settings, now = Date.now()) => settings.pausedUntil > now;

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
  };
}

export async function saveSweepState(patch) {
  const current = await loadSweepState();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ sweepState: next });
  return next;
}
