// Coordinator, and the only context that writes to the database.
//
// It is stopped whenever Chrome decides it looks idle, so nothing important
// lives in memory between events and every listener is registered
// synchronously at the top level. A listener added inside an async callback
// can miss the very event that woke the worker.

import { MSG } from '../shared/messages.js';
import { MAX_TEXT_BYTES } from '../shared/constants.js';
import { decide, MODE } from '../core/capture-policy.js';
import { isRead } from '../core/read-heuristic.js';
import { search } from '../core/index-reader.js';
import { planEviction, budgetStatus, projectExhaustion, paceFrom } from '../core/eviction.js';
import { openStore } from '../db/idb-store.js';
import { loadSettings, saveSettings, isPaused } from '../shared/settings.js';
import { rulesFor } from '../shared/presets.js';

const CONTENT_SCRIPT_ID = 'observer';

// Cached for the lifetime of this worker only, which is the point: when the
// worker is restarted the module is re-evaluated and the handle is reopened.
let storePromise = null;
const getStore = () => {
  if (!storePromise) storePromise = openStore();
  return storePromise;
};

// Content scripts are registered at runtime rather than declared in the
// manifest, so install time asks for no host access at all. Broad mode gets
// the wide permission during setup, strict mode gets one origin at a time.
async function syncContentScripts() {
  const settings = await loadSettings();
  const existing = await chrome.scripting
    .getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] })
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

async function onPageCandidate(payload, sender) {
  const settings = await loadSettings();
  const verdict = decide({
    url: payload.url,
    mode: settings.mode,
    allowlist: settings.allowlist,
    rules: rulesFor(settings.presets, settings.customRules),
    hasPasswordField: payload.hasPasswordField,
    incognito: sender && sender.tab ? sender.tab.incognito === true : false,
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

async function onPageContent(payload) {
  const store = await getStore();
  // The cap is on stored text, not on what was extracted, so a very long
  // page is truncated rather than refused.
  const text = (payload.text || '').slice(0, MAX_TEXT_BYTES);
  const result = await store.putPage({
    url: payload.url,
    title: payload.title || '',
    text,
    lastSeen: payload.capturedAt || Date.now(),
  });
  return { ok: true, ...result };
}

async function collectStats() {
  const store = await getStore();
  const settings = await loadSettings();
  const [stats, meta, log] = await Promise.all([
    store.readStats(),
    store.listPageMeta(),
    store.readEvictionLog(5),
  ]);

  const usedBytes = meta.reduce((sum, page) => sum + (page.bytes || 0), 0);
  const budget = budgetStatus({
    usedBytes,
    sizeCapBytes: settings.sizeCapBytes,
    warnAtFraction: settings.warnAtFraction || 0.8,
  });
  const pace = paceFrom(meta);
  const exhaustsAt = projectExhaustion({
    usedBytes,
    sizeCapBytes: settings.sizeCapBytes,
    bytesPerDay: pace.bytesPerDay,
  });

  return {
    ready: true,
    docCount: stats.docCount,
    usedBytes,
    budget,
    pace,
    // Only worth showing once there is enough history to mean anything.
    exhaustsAt: pace.daysObserved >= 7 ? exhaustsAt : null,
    paused: isPaused(settings),
    mode: settings.mode,
    recentEvictions: log,
  };
}

async function forget(payload) {
  const store = await getStore();
  if (payload.scope === 'page') {
    return store.deletePages([payload.id]);
  }
  const meta = await store.listPageMeta();
  let ids = [];
  if (payload.scope === 'site') {
    ids = meta.filter((page) => page.domain === payload.value).map((page) => page.id);
  } else if (payload.scope === 'day') {
    const from = new Date(payload.value).setHours(0, 0, 0, 0);
    const to = from + 86400000;
    ids = meta.filter((page) => page.lastSeen >= from && page.lastSeen < to).map((page) => page.id);
  }
  return store.deletePages(ids);
}

async function runMaintenance() {
  const store = await getStore();
  const settings = await loadSettings();
  const meta = await store.listPageMeta();

  const plan = planEviction({
    pages: meta,
    retentionMonths: settings.retentionMonths,
    sizeCapBytes: settings.sizeCapBytes,
  });

  if (plan.ids.length) {
    const result = await store.deletePages(plan.ids);
    // Nothing is ever removed without a record of it. This is the entry the
    // storage log in the interface reads.
    await store.logEviction({
      reason: plan.reason,
      count: result.deleted,
      bytesFreed: result.bytesFreed,
      counts: plan.counts,
    });
  }

  // The budget warning is a badge and a line in the popup, never an OS
  // notification, which is why this extension does not ask for that
  // permission at all.
  const stats = await collectStats();
  if (stats.budget.level === 'warn' || stats.budget.level === 'over') {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
  return { evicted: plan.ids.length, budget: stats.budget.level };
}

chrome.runtime.onInstalled.addListener(async () => {
  await syncContentScripts();
  chrome.alarms.create('maintenance', { periodInMinutes: 60 });
});

chrome.runtime.onStartup.addListener(syncContentScripts);
chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'open-search') return;
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/search/search.html') });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'maintenance') runMaintenance();
});

const escapeXml = (text) =>
  String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  if (!text.trim()) return suggest([]);
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

    case MSG.SEARCH:
      return reply(
        getStore().then((store) =>
          search(payload.query, {
            store,
            limit: payload.limit || 20,
            offset: payload.offset || 0,
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

    default:
      return false;
  }
});
