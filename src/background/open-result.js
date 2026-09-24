// Opening a search result, and saying something true about the page in front
// of you. Both of these are about a tab rather than about the archive, which
// is why they sit together.

import { fragmentUrl } from '../core/text-fragment.js';
import { urlKey } from '../core/url-key.js';
import { decide, MODE } from '../core/capture-policy.js';
import { loadSettings, policyInput } from '../shared/settings.js';
import { getStore } from './store-handle.js';
import { injectExtractor } from './capture.js';
import { readOutcome, forgetOutcome } from './outcomes.js';

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
        window.__readingArchiveQuote = text;
        window.__readingArchiveOnlyIfUnscrolled = only;
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

// Opening a result, with two facts established by testing. A text
// fragment only fires on a fresh document load, so a tab that is already
// open on the page needs the highlight script instead. And a fragment does
// not wait for content that arrives after load, so a new tab that ends up
// unscrolled gets the same treatment as a second attempt.
export async function openResult({ url, quote }) {
  // Only ever a web page. The store refuses anything else on the way in,
  // and this is the second lock on the same door.
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { opened: false };
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

export async function pageStatus(url, tabId = null) {
  const settings = await loadSettings();
  const tab = typeof tabId === 'number' ? await chrome.tabs.get(tabId).catch(() => null) : null;

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

  let verdict = decide({
    url,
    ...policyInput(settings, { incognito: !!(tab && tab.incognito) }),
  });

  // Strict mode asks about the allowlist before the exclusions, so a site
  // the exclusions cover reads as "not on your allowlist", and adding it
  // would grant Chrome access to a site that is then refused anyway.
  const anyMode = decide({
    url,
    ...policyInput(settings, { incognito: !!(tab && tab.incognito), mode: MODE.BROAD }),
  });
  const excluded = !anyMode.capture && /^(excluded|the address contains)/.test(anyMode.reason)
    ? anyMode.reason
    : null;

  // The address can pass while the page itself did not: a password field, a
  // page with nothing on it to keep, an extraction that failed. Only the tab
  // knows that, and it has said so; see outcomes.js.
  let fromPage = false;
  if (!page && verdict.capture) {
    const outcome = await readOutcome(tabId, url);
    if (outcome && !outcome.ok && outcome.reason) {
      verdict = { capture: false, reason: outcome.reason };
      fromPage = true;
    }
  }

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
    excluded,
    // The refusal was about what was on the page, which can change: a
    // sign-in form dismissed, content that loaded late. Worth another try.
    retryable: fromPage,
    hasSitePermission: granted,
  };
}

// Keeping a page you are looking at, without waiting for the dwell and
// scroll heuristic to be satisfied. The heuristic exists to avoid a landfill
// of pages nobody read, not to argue with someone who is telling you
// directly that this one matters.
//
// Everything else still applies, a pause included. A pause is somebody
// saying "not now", and the text arriving from the tab is checked against
// the same policy when it lands, so an override here could only ever say
// "capturing" about a page that was then refused.
export async function captureNow(tabId, url) {
  const settings = await loadSettings();
  const tab = typeof tabId === 'number' ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (!tab || !tab.url || urlKey(tab.url) !== urlKey(url)) return { ok: false, reason: 'this tab has moved on to another page' };
  const verdict = decide({ url, ...policyInput(settings, { incognito: !!tab.incognito }) });
  if (!verdict.capture) return { ok: false, reason: verdict.reason };
  // A stale refusal from before would otherwise answer for this attempt.
  await forgetOutcome(tabId);
  const injected = await injectExtractor(tabId, { explicit: true });
  return { ok: injected, reason: injected ? 'capturing' : 'could not read this tab' };
}
