// Coordinator. The only context that decides policy, and the only one that
// will write to the database. It dies constantly, so nothing important is
// kept in memory between events.

import { MSG } from '../shared/messages.js';
import { decide, MODE } from '../core/capture-policy.js';
import { isRead } from '../core/read-heuristic.js';
import { loadSettings, isPaused } from '../shared/settings.js';
import { rulesFor } from '../shared/presets.js';

const CONTENT_SCRIPT_ID = 'observer';

// Content scripts are registered at runtime rather than declared in the
// manifest, so install time asks for no host access at all. Broad mode gets
// the wide permission during setup, strict mode gets one origin at a time.
async function syncContentScripts() {
  const settings = await loadSettings();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] })
    .catch(() => []);

  let matches = [];
  if (settings.mode === MODE.BROAD) {
    const granted = await chrome.permissions.contains({ origins: ['*://*/*'] });
    matches = granted ? ['http://*/*', 'https://*/*'] : [];
  } else {
    matches = settings.allowlist.map((host) => 'https://*.' + host.replace(/^\*\./, '') + '/*');
  }

  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  }
  if (!matches.length) return;

  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      js: ['src/content/observer.js'],
      matches,
      runAt: 'document_idle',
      allFrames: false,
    },
  ]);
}

chrome.runtime.onInstalled.addListener(async () => {
  await syncContentScripts();
  chrome.alarms.create('maintenance', { periodInMinutes: 60 });
});

chrome.runtime.onStartup.addListener(syncContentScripts);
chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'maintenance') return;
  // TODO(step 8): retention sweep, budget check, threshold notices.
});

async function onPageCandidate(payload, sender) {
  const settings = await loadSettings();
  const verdict = decide({
    url: payload.url,
    mode: settings.mode,
    allowlist: settings.allowlist,
    rules: rulesFor(settings.presets, settings.customRules),
    hasPasswordField: payload.hasPasswordField,
    incognito: sender?.tab?.incognito === true,
    paused: isPaused(settings),
  });
  if (!verdict.capture) return verdict;

  const read = isRead({
    focusedMs: payload.focusedMs,
    scrollDepth: payload.scrollDepth,
    wordCount: payload.wordCount,
  });
  return read ? { capture: true, reason: 'read' } : { capture: false, reason: 'still reading' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message || {};
  switch (type) {
    case MSG.PAGE_CANDIDATE:
      onPageCandidate(payload, sender).then(sendResponse);
      return true;

    case MSG.PAGE_CONTENT:
      // TODO(step 5): normalise, dedupe on urlKey, write page row, index it.
      sendResponse({ ok: true, stored: false });
      return true;

    case MSG.SEARCH:
      // TODO(step 5): hand the injected IndexedDB store to core/index-reader.
      sendResponse({ results: [], total: 0, mode: 'empty', tookMs: 0 });
      return true;

    case MSG.STATS:
      sendResponse({ docCount: 0, bytes: 0, ready: false });
      return true;

    default:
      return false;
  }
});
