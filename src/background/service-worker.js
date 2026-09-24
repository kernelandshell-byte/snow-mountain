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
import { loadSettings, saveSettings } from '../shared/settings.js';
import { refreshPersistence } from '../shared/persistence.js';
import { getStore, withStore } from './store-handle.js';
import { syncContentScripts } from './content-scripts.js';
import { onPageCandidate, onPageContent, onPdfBytes } from './capture.js';
import { closeOffscreenIfIdle, OFFSCREEN_IDLE_ALARM } from './pdf-extract.js';
import { openResult, pageStatus, captureNow } from './open-result.js';
import {
  allowSite, blockSite, buildExport, importPages, wipeEverything, forget,
  removeExcluded, removeExcludedIfPending, noteNewCategories,
} from './archive.js';
import { collectStats, runMaintenance } from './maintenance.js';
import { refreshBadge, UNPAUSE_ALARM } from './badge.js';
import { forgetOutcome } from './outcomes.js';

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

  // Chrome clears the badge on restart. A warning that still applies has to
  // come back with it, or it only ever appears once.
  await refreshBadge().catch(() => {});

  // An update that was stopped before it finished applying its lists.
  await removeExcludedIfPending().catch(() => {});
}

chrome.runtime.onInstalled.addListener(async (details) => {
  // Earlier builds kept pages that today's lists skip. Marked before
  // ensureRunning, which is what applies it.
  if (details.reason === 'update') {
    await noteNewCategories().catch(() => {});
    await chrome.storage.local.set({ exclusionSweepPending: true }).catch(() => {});
  }
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
  if (alarm.name === UNPAUSE_ALARM) refreshBadge();
});

// What a tab last reported is only about that tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetOutcome(tabId);
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
    const { stemLanguages } = await loadSettings();
    const { results } = await search(text, { store, limit: 6, stemLanguages });
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

// The only messages a content script has any reason to send. Content scripts
// run inside web pages, so a page that manages to compromise its own
// renderer can send whatever that script could. Everything else -- search,
// export, delete everything, settings -- is answered only for this
// extension's own pages.
const FROM_WEB_PAGES = new Set([MSG.PAGE_CANDIDATE, MSG.PAGE_CONTENT, MSG.PDF_BYTES]);
const EXTENSION_ORIGIN = chrome.runtime.getURL('');
// The offscreen document is an extension page, but its job is running pdf.js
// over PDFs from the web, and it only ever answers the worker. Should a
// hostile PDF ever get code running in it, it must not be able to ask for an
// export, a wipe or a settings change the way settings can.
const OFFSCREEN_ORIGIN = chrome.runtime.getURL('src/offscreen/');
const fromExtensionPage = (sender) =>
  !!sender && sender.id === chrome.runtime.id &&
  typeof sender.url === 'string' && sender.url.startsWith(EXTENSION_ORIGIN) &&
  !sender.url.startsWith(OFFSCREEN_ORIGIN);

// What settings may clear once it has shown it: a one-off notice, never the
// settings or the sweep's own state.
const ACKNOWLEDGEABLE = new Set(['lastMigration']);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message || {};
  if (!FROM_WEB_PAGES.has(type) && !fromExtensionPage(sender)) return false;
  const reply = (promise) => {
    promise.then(sendResponse).catch((error) => sendResponse({ error: String(error.message || error) }));
    return true;
  };

  switch (type) {
    case MSG.PAGE_CANDIDATE:
      return reply(onPageCandidate(payload, sender));

    case MSG.PAGE_CONTENT:
      return reply(onPageContent(payload, sender));

    case MSG.PDF_BYTES:
      return reply(onPdfBytes(payload, sender));

    case MSG.SEARCH:
      return reply(
        withStore(async (store) => {
          const { stemLanguages } = await loadSettings();
          return search(payload.query, {
            store,
            limit: payload.limit || 20,
            offset: payload.offset || 0,
            filters: payload.filters || {},
            stemLanguages,
          });
        })
      );

    case MSG.STATS:
      return reply(collectStats());

    case MSG.PIN:
      return reply(getStore().then((store) => store.setPinned(payload.id, payload.pinned)));

    case MSG.FORGET:
      return reply(forget(payload));

    case MSG.RECENT:
      // `slim` for a list of titles, which has no use for a few hundred
      // kilobytes of body per page crossing the message channel.
      return reply(getStore().then(async (store) => {
        const pages = await store.listRecent(payload?.limit || 10);
        if (!payload?.slim) return pages;
        return pages.map((page) => ({
          id: page.id, url: page.url, title: page.title, domain: page.domain,
          lastSeen: page.lastSeen, pinned: !!page.pinned,
        }));
      }));

    case MSG.SETTINGS_GET:
      return reply(loadSettings());

    case MSG.SETTINGS_SET:
      return reply(saveSettings(payload).then(async (settings) => {
        await syncContentScripts();
        await refreshBadge().catch(() => {});
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
      return reply(pageStatus(payload.url, payload.tabId));

    case MSG.CAPTURE_NOW:
      return reply(captureNow(payload.tabId, payload.url));

    case MSG.ALLOW_SITE:
      return reply(allowSite(payload.domain));

    case MSG.BLOCK_SITE:
      return reply(blockSite(payload.domain, { dryRun: payload.dryRun === true }));

    case MSG.REMOVE_EXCLUDED:
      return reply(removeExcluded(payload || {}));

    case MSG.ACKNOWLEDGE:
      if (!payload || !ACKNOWLEDGEABLE.has(payload.what)) return reply(Promise.resolve({ ok: false }));
      return reply(chrome.storage.local.remove(payload.what).then(() => ({ ok: true })));

    case MSG.LOG:
      return reply(getStore().then((store) => store.readEvictionLog(payload?.limit || 20)));

    default:
      return false;
  }
});
