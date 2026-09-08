// Coordinator, and the only context that writes to the database.
//
// It is stopped whenever Chrome decides it looks idle, so nothing important
// lives in memory between events and every listener is registered
// synchronously at the top level. A listener added inside an async callback
// can miss the very event that woke the worker.

import { MSG } from '../shared/messages.js';
import { MAX_TEXT_BYTES, MIN_TEXT_CHARS, MIN_TEXT_OVER_TITLE } from '../shared/constants.js';
import { decide, MODE } from '../core/capture-policy.js';
import { isRead } from '../core/read-heuristic.js';
import { search } from '../core/index-reader.js';
import { planEviction, budgetStatus, projectExhaustion, paceFrom } from '../core/eviction.js';
import { fragmentUrl } from '../core/text-fragment.js';
import { urlKey } from '../core/url-key.js';
import { openStore, isClosedError } from '../db/idb-store.js';
import { loadSettings, saveSettings, isPaused } from '../shared/settings.js';
import { rulesFor } from '../shared/presets.js';

const CONTENT_SCRIPT_ID = 'observer';

// Cached for the lifetime of this worker only, which is the point: when the
// worker is restarted the module is re-evaluated and the handle is reopened.
let storePromise = null;
const getStore = () => {
  if (!storePromise) {
    storePromise = openStore({
      // Chrome closes the connection when the database is deleted or
      // upgraded elsewhere, which is what clearing site data looks like from
      // in here. Dropping the handle means the next call opens a fresh one
      // rather than failing forever against a dead one.
      onClosed: () => {
        storePromise = null;
      },
    }).catch((error) => {
      // Never keep a rejected promise: one transient failure would
      // otherwise disable storage until the worker happened to restart.
      storePromise = null;
      throw error;
    });
  }
  return storePromise;
};

// Any operation can fail against a connection that has just gone away. One
// retry against a fresh handle turns that from a lost page into a hiccup.
async function withStore(work) {
  try {
    return await work(await getStore());
  } catch (error) {
    if (!isClosedError(error)) throw error;
    storePromise = null;
    return work(await getStore());
  }
}

// Content scripts are registered at runtime rather than declared in the
// manifest, so install time asks for no host access at all. Broad mode gets
// the wide permission during setup, strict mode gets one origin at a time.
let syncing = null;
function syncContentScripts() {
  // Serialised, because a settings save and a permission event can arrive
  // together and the second registration would fail on a duplicate id.
  syncing = (syncing || Promise.resolve()).then(doSyncContentScripts, doSyncContentScripts);
  return syncing;
}

async function doSyncContentScripts() {
  const settings = await loadSettings();
  const existing = await chrome.scripting
    .getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] })
    .catch(() => []);

  let matches = [];
  if (settings.mode === MODE.BROAD) {
    const granted = await chrome.permissions.contains({ origins: ['*://*/*'] });
    matches = granted ? ['http://*/*', 'https://*/*'] : [];
  } else {
    // Both schemes, to match the permission the popup actually requests.
    matches = settings.allowlist.map((host) => '*://*.' + host.replace(/^\*\./, '') + '/*');
  }

  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  }
  if (!matches.length) return;

  await chrome.scripting
    .registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        js: ['src/content/observer.js'],
        matches,
        runAt: 'document_idle',
        allFrames: false,
      },
    ])
    .catch(() => {
      // Registration can lose a race with an unregister that has not landed
      // yet. The next settings change or startup registers it again.
    });
}

// Extraction is injected only once a page has earned it. Putting 90KB of
// parser into every page a person opens would be a strange thing to do to
// their browser, and most pages never qualify.
async function injectExtractor(tabId, { explicit = false } = {}) {
  if (typeof tabId !== 'number') return false;
  try {
    if (explicit) {
      // Carried through a global, the same way the quote reaches the
      // highlight script: a content script cannot take arguments.
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          window.__snowMountainExplicit = true;
        },
      });
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/vendor/readability/Readability.js', 'src/content/extract.js'],
    });
    return true;
  } catch {
    // A tab that navigated away, or a page the extension has no access to.
    // Nothing to recover: the next visit will offer the page again.
    return false;
  }
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
  if (!read) return { capture: false, reason: 'still reading' };

  const injected = await injectExtractor(sender && sender.tab ? sender.tab.id : null);
  return { capture: true, reason: injected ? 'read' : 'read, but extraction could not be injected' };
}

// A canonical URL is only trusted when it stays on the same host. Plenty of
// sites point canonical at a syndication partner, and following that would
// file the page under someone else's domain.
function preferredUrl(url, canonicalUrl) {
  if (!canonicalUrl) return url;
  try {
    if (new URL(canonicalUrl).hostname === new URL(url).hostname) return canonicalUrl;
  } catch {
    return url;
  }
  return url;
}

async function onPageContent(payload) {
  return withStore(async (store) => {
    // The cap is on stored text, not on what was extracted, so a very long
    // page is truncated rather than refused.
    const text = (payload.text || '').slice(0, MAX_TEXT_BYTES);
    if (!text.trim()) return { ok: false, reason: 'nothing to index' };
    const title = payload.title || '';
    const trimmed = text.trim();
    if (
      !payload.explicit &&
      (trimmed.length < MIN_TEXT_CHARS || trimmed.length < title.length + MIN_TEXT_OVER_TITLE)
    ) {
      return { ok: false, reason: 'too little text to be worth finding later' };
    }

    const result = await store.putPage({
      url: preferredUrl(payload.url, payload.canonicalUrl),
      title: payload.title || '',
      text,
      lastSeen: payload.capturedAt || Date.now(),
    });
    return { ok: true, ...result };
  });
}

async function collectStats() {
  const store = await getStore();
  const settings = await loadSettings();
  // Deliberately not listPageMeta: this runs every time the popup opens, and
  // summing bytes across every stored page would make that scale with the
  // size of the archive.
  const [stats, oldestFirstSeen, log] = await Promise.all([
    store.readStats(),
    store.oldestFirstSeen(),
    store.readEvictionLog(5),
  ]);

  const usedBytes = stats.totalBytes;
  const budget = budgetStatus({
    usedBytes,
    sizeCapBytes: settings.sizeCapBytes,
    warnAtFraction: settings.warnAtFraction || 0.8,
  });
  const pace = paceFrom({ totalBytes: usedBytes, oldestFirstSeen });
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
    setupComplete: settings.setupComplete,
    recentEvictions: log,
  };
}

// What the popup needs to say something true about the page in front of you:
// whether it is kept, and if not, why not. The reason strings come straight
// out of the capture policy, which is why they were written to be read.
async function runHighlight(tabId, quote, onlyIfUnscrolled) {
  try {
    // A content script takes no arguments, so the quote is handed over in a
    // global in the same isolated world.
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (text, only) => {
        window.__snowMountainQuote = text;
        window.__snowMountainOnlyIfUnscrolled = only;
      },
      args: [quote, onlyIfUnscrolled === true],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/highlight.js'],
    });
    return true;
  } catch {
    return false;
  }
}

// Opening a result, with the two facts the spike established. A text
// fragment only fires on a fresh document load, so a tab that is already
// open on the page needs the highlight script instead. And a fragment does
// not wait for content that arrives after load, so a new tab that ends up
// unscrolled gets the same treatment as a second attempt.
async function openResult({ url, quote }) {
  const bare = url.split('#')[0];

  // Matching on the normalised key rather than handing the URL to
  // chrome.tabs.query as a match pattern. A pattern cannot express "the same
  // page carrying different tracking parameters", and that is the common
  // case: the stored URL and the one in the open tab rarely agree exactly.
  const wanted = urlKey(bare);
  const tabs = wanted ? await chrome.tabs.query({}).catch(() => []) : [];
  const existing = tabs.filter((tab) => tab.url && urlKey(tab.url) === wanted);

  if (existing.length) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    const highlighted = quote ? await runHighlight(tab.id, quote, false) : false;
    return { opened: 'existing', tabId: tab.id, highlighted };
  }

  const tab = await chrome.tabs.create({ url: quote ? fragmentUrl(bare, quote) : bare });
  if (!quote) return { opened: 'new', tabId: tab.id, highlighted: false };

  // Wait for the load to finish before checking whether the fragment took.
  await new Promise((resolve) => {
    const done = (tabId, info) => {
      if (tabId !== tab.id || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(done);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(done);
      resolve();
    }, 8000);
  });

  await runHighlight(tab.id, quote, true);
  return { opened: 'new', tabId: tab.id, highlighted: 'ifNeeded' };
}

async function pageStatus(url) {
  const settings = await loadSettings();
  const store = await getStore();
  const page = await store.getPageByUrl(url);

  const verdict = decide({
    url,
    mode: settings.mode,
    allowlist: settings.allowlist,
    rules: rulesFor(settings.presets, settings.customRules),
    hasPasswordField: false,
    incognito: false,
    paused: isPaused(settings),
  });

  let domain = null;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    domain = null;
  }

  const granted = domain
    ? await chrome.permissions.contains({ origins: ['*://' + domain + '/*'] }).catch(() => false)
    : false;

  return {
    url,
    domain,
    mode: settings.mode,
    kept: page
      ? { id: page.id, lastSeen: page.lastSeen, visitCount: page.visitCount, pinned: !!page.pinned }
      : null,
    capturable: verdict.capture,
    reason: verdict.reason,
    hasSitePermission: granted,
  };
}

// Keeping a page you are looking at, without waiting for the dwell and
// scroll heuristic to be satisfied. The heuristic exists to avoid a landfill
// of pages nobody read, not to argue with someone who is telling you
// directly that this one matters.
async function captureNow(tabId, url) {
  const settings = await loadSettings();
  const verdict = decide({
    url,
    mode: settings.mode,
    allowlist: settings.allowlist,
    rules: rulesFor(settings.presets, settings.customRules),
    hasPasswordField: false,
    incognito: false,
    // An explicit request overrides a pause, which is about background
    // capture rather than about this one page.
    paused: false,
  });
  if (!verdict.capture) return { ok: false, reason: verdict.reason };
  const injected = await injectExtractor(tabId, { explicit: true });
  return { ok: injected, reason: injected ? 'capturing' : 'could not read this tab' };
}

async function allowSite(domain) {
  const settings = await loadSettings();
  if (settings.allowlist.includes(domain)) return settings;
  const next = await saveSettings({ allowlist: [...settings.allowlist, domain] });
  await syncContentScripts();
  return next;
}

// Blocking a site is not only about the future. Leaving what was already
// captured in place would make the button a lie.
async function blockSite(domain) {
  const settings = await loadSettings();
  const rules = settings.customRules.includes(domain)
    ? settings.customRules
    : [...settings.customRules, domain];
  await saveSettings({
    customRules: rules,
    allowlist: settings.allowlist.filter((entry) => entry !== domain),
  });
  await syncContentScripts();

  const store = await getStore();
  const meta = await store.listPageMeta();
  const ids = meta.filter((page) => page.domain === domain).map((page) => page.id);
  const result = ids.length ? await store.deletePages(ids) : { deleted: 0, bytesFreed: 0 };
  if (result.deleted) {
    await store.logEviction({
      reason: 'siteRule',
      count: result.deleted,
      bytesFreed: result.bytesFreed,
    });
  }
  return { removed: result.deleted };
}

async function buildExport() {
  const store = await getStore();
  const settings = await loadSettings();
  const meta = await store.listPageMeta();
  const docs = await store.readDocs(meta.map((page) => page.id));

  // Plain JSON with the full text, not an opaque blob. The point of an
  // export is that it is readable without this extension existing.
  return {
    format: 'snow-mountain-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      mode: settings.mode,
      retentionMonths: settings.retentionMonths,
      sizeCapBytes: settings.sizeCapBytes,
      presets: settings.presets,
      customRules: settings.customRules,
    },
    pages: [...docs.values()].map((page) => ({
      url: page.url,
      title: page.title,
      domain: page.domain,
      firstSeen: new Date(page.firstSeen).toISOString(),
      lastSeen: new Date(page.lastSeen).toISOString(),
      visitCount: page.visitCount,
      pinned: !!page.pinned,
      text: page.text,
    })),
  };
}

// Import takes one batch at a time. The interface does the chunking, so a
// large archive reports progress instead of sitting silent for ten minutes,
// and no single message has to survive that long.
async function importPages(pages) {
  const store = await getStore();
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const page of pages || []) {
    if (!page || !page.url || !page.text) {
      failed += 1;
      continue;
    }
    try {
      const result = await store.putPage({
        url: page.url,
        title: page.title || '',
        text: page.text,
        lastSeen: Date.parse(page.lastSeen) || Date.now(),
        firstSeen: Date.parse(page.firstSeen) || null,
        visitCount: page.visitCount || null,
        pinned: !!page.pinned,
      });
      // Already there, unchanged: importing the same archive twice should
      // not look like it did something.
      if (!result.created && !result.reindexed) skipped += 1;
      else imported += 1;
    } catch {
      failed += 1;
    }
  }
  return { imported, skipped, failed };
}

async function wipeEverything() {
  const store = await getStore();
  const meta = await store.listPageMeta();
  const result = await store.deletePages(meta.map((page) => page.id));
  await store.logEviction({ reason: 'manual', count: result.deleted, bytesFreed: result.bytesFreed });
  return result;
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

chrome.runtime.onInstalled.addListener(async (details) => {
  await syncContentScripts();
  chrome.alarms.create('maintenance', { periodInMinutes: 60 });

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
      return reply(buildExport());

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

    case MSG.LOG:
      return reply(getStore().then((store) => store.readEvictionLog(payload?.limit || 20)));

    default:
      return false;
  }
});
