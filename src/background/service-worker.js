// Coordinator, and the only context that writes to the database.
//
// It is stopped whenever Chrome decides it looks idle, so nothing important
// lives in memory between events and every listener is registered
// synchronously at the top level, here, in this file. A listener added inside
// an async callback, or in a module that is imported lazily, can miss the very
// event that woke the worker -- which is why the work is spread across the
// modules beside this one but the wiring is not.

import { MSG } from '../shared/messages.js';
import { search } from '../core/index-reader.js';
import { loadSettings, saveSettings, loadSweepState } from '../shared/settings.js';
import { refreshPersistence } from '../shared/persistence.js';
import { getStore, withStore } from './store-handle.js';
import { syncContentScripts } from './content-scripts.js';
import { onPageCandidate, onPageContent, onPdfBytes } from './capture.js';
import { closeOffscreenIfIdle, OFFSCREEN_IDLE_ALARM } from './pdf-extract.js';
import { openResult, pageStatus, captureNow } from './open-result.js';
import {
  allowSite, blockSite, buildExport, importPages, wipeEverything, forget,
} from './archive.js';
import { collectStats, runMaintenance } from './maintenance.js';

// Everything the worker has to be sure of each time it comes back, whether
// that is an install, a browser start, or an update. All of it is idempotent,
// because it runs far more often than it does anything.
async function ensureRunning() {
  await syncContentScripts();
  // An alarm survives a restart, but not a profile that lost it, and an
  // extension whose only sweep is one scheduled at install time would quietly
  // stop applying the budget for ever.
  const existing = await chrome.alarms.get('maintenance').catch(() => null);
  if (!existing) chrome.alarms.create('maintenance', { periodInMinutes: 60 });

  // A worker can only read this back; asking is a window's job, and the
  // pages that can ask do so. See shared/persistence.js.
  await refreshPersistence();

  // Chrome clears the badge on restart. If the budget still cannot be met,
  // the warning has to come back with it, or it only ever appears once.
  const sweepState = await loadSweepState();
  if (sweepState.capUnmeetable) {
    await chrome.action.setBadgeText({ text: '!' }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: '#b45309' }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureRunning();

  // Nothing is captured until someone has chosen a mode and granted access,
  // so a fresh install that never opens setup would sit there doing nothing
  // and look broken.
  if (details.reason === 'install') {
    const settings = await loadSettings();
    if (!settings.setupComplete) {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/setup/setup.html') });
    }
  }
});

chrome.runtime.onStartup.addListener(ensureRunning);
chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'open-search') return;
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/search/search.html') });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'maintenance') runMaintenance();
  if (alarm.name === OFFSCREEN_IDLE_ALARM) closeOffscreenIfIdle();
});

const escapeXml = (text) =>
  String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  if (!text.trim()) return suggest([]);
  try {
    const store = await getStore();
    const { results } = await search(text, { store, limit: 6 });
    suggest(
      results.map((result) => ({
        content: result.url,
        description:
          '<match>' + escapeXml(result.title || result.url) + '</match> <dim>' +
          escapeXml(result.domain) + '</dim>',
      }))
    );
  } catch {
    // The address bar is the fastest path into this extension and it is used
    // mid keystroke. An archive that will not open makes it show nothing,
    // which is the only sensible thing it can do there, but an unhandled
    // rejection here would take the worker down with it.
    suggest([]);
  }
});

chrome.omnibox.onInputEntered.addListener(async (text) => {
  if (/^https?:\/\//.test(text)) {
    chrome.tabs.create({ url: text });
    return;
  }
  chrome.tabs.create({
    url: chrome.runtime.getURL('src/ui/search/search.html') + '?q=' + encodeURIComponent(text),
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message || {};
  const reply = (promise) => {
    promise.then(sendResponse).catch((error) => sendResponse({ error: String(error.message || error) }));
    return true;
  };

  switch (type) {
    case MSG.PAGE_CANDIDATE:
      return reply(onPageCandidate(payload, sender));

    case MSG.PAGE_CONTENT:
      return reply(onPageContent(payload));

    case MSG.PDF_BYTES:
      return reply(onPdfBytes(payload, sender));

    case MSG.SEARCH:
      return reply(
        withStore((store) =>
          search(payload.query, {
            store,
            limit: payload.limit || 20,
            offset: payload.offset || 0,
            filters: payload.filters || {},
          })
        )
      );

    case MSG.STATS:
      return reply(collectStats());

    case MSG.PIN:
      return reply(getStore().then((store) => store.setPinned(payload.id, payload.pinned)));

    case MSG.FORGET:
      return reply(forget(payload));

    case MSG.RECENT:
      return reply(getStore().then((store) => store.listRecent(payload?.limit || 10)));

    case MSG.SETTINGS_GET:
      return reply(loadSettings());

    case MSG.SETTINGS_SET:
      return reply(saveSettings(payload).then(async (settings) => {
        await syncContentScripts();
        return settings;
      }));

    case MSG.MAINTENANCE:
      return reply(runMaintenance());

    case MSG.EXPORT:
      return reply(buildExport(payload || {}));

    case MSG.IMPORT:
      return reply(importPages(payload.pages));

    case MSG.WIPE:
      return reply(wipeEverything());

    case MSG.OPEN_RESULT:
      return reply(openResult(payload));

    case MSG.PAGE_STATUS:
      return reply(pageStatus(payload.url));

    case MSG.CAPTURE_NOW:
      return reply(captureNow(payload.tabId, payload.url));

    case MSG.ALLOW_SITE:
      return reply(allowSite(payload.domain));

    case MSG.BLOCK_SITE:
      return reply(blockSite(payload.domain));

    case MSG.ACKNOWLEDGE:
      return reply(chrome.storage.local.remove(payload.what).then(() => ({ ok: true })));

    case MSG.LOG:
      return reply(getStore().then((store) => store.readEvictionLog(payload?.limit || 20)));

    default:
      return false;
  }
});
