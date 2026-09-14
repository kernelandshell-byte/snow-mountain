// Opening a search result, and saying something true about the page in front
// of you. Both of these are about a tab rather than about the archive, which
// is why they sit together.

import { fragmentUrl } from '../core/text-fragment.js';
import { urlKey } from '../core/url-key.js';
import { decide } from '../core/capture-policy.js';
import { loadSettings, isPaused } from '../shared/settings.js';
import { rulesFor } from '../shared/presets.js';
import { getStore } from './store-handle.js';
import { injectExtractor } from './capture.js';

// What the popup needs to say something true about the page in front of you:
// whether it is kept, and if not, why not. The reason strings come straight
// out of the capture policy, which is why they were written to be read.
export async function runHighlight(tabId, quote, onlyIfUnscrolled) {
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
export async function openResult({ url, quote }) {
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

export async function pageStatus(url) {
  const settings = await loadSettings();

  // Whether this page is already kept is only half the answer. The other half
  // is whether it would be kept, and that comes from settings, which still
  // work when the archive does not.
  let page = null;
  let archiveReady = true;
  try {
    page = await (await getStore()).getPageByUrl(url);
  } catch {
    archiveReady = false;
  }

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
    archiveReady,
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
export async function captureNow(tabId, url) {
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
