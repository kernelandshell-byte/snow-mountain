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
  },
  retentionMonths: DEFAULTS.retentionMonths,
  sizeCapBytes: DEFAULTS.sizeCapBytes,
  pausedUntil: 0,
  warnedAtFraction: 0,
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...SETTINGS_DEFAULTS, ...(stored.settings || {}) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export const isPaused = (settings, now = Date.now()) => settings.pausedUntil > now;
