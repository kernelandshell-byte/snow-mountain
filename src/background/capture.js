// Everything on the path from "a tab says it was read" to "a page is in the
// archive". The judgement lives here; the content script only measures.

import {
  MAX_TEXT_BYTES, MAX_PDF_BYTES, MIN_TEXT_CHARS, MIN_TEXT_OVER_TITLE,
} from '../shared/constants.js';
import { decide } from '../core/capture-policy.js';
import { truncateUtf8 } from '../shared/format.js';
import { isRead } from '../core/read-heuristic.js';
import { isSuspiciousShrink } from '../core/content-change.js';
import { canonicalFor } from '../core/url-key.js';
import { loadSettings, policyInput } from '../shared/settings.js';
import { isQuotaError } from '../db/idb-store.js';
import { getStore, withStore } from './store-handle.js';
import { extractPdfText } from './pdf-extract.js';
import { recordOutcome } from './outcomes.js';
import { refreshBadge } from './badge.js';

const EXTENSION_ORIGIN = chrome.runtime.getURL('');
const OFFSCREEN_ORIGIN = chrome.runtime.getURL('src/offscreen/');
const senderUrl = (sender) => (sender && (sender.url || (sender.tab && sender.tab.url))) || '';

// A message from one of this extension's own pages (an import, a test
// harness) rather than a page reporting on itself. Not the offscreen
// document, which parses PDFs from the web and has no pages to report.
const fromExtension = (sender) =>
  !sender ||
  ((!sender.tab || senderUrl(sender).startsWith(EXTENSION_ORIGIN)) &&
    !senderUrl(sender).startsWith(OFFSCREEN_ORIGIN));

// The content scripts only ever run in a tab's top frame. A report from a
// frame inside it is not one of them, and must not be able to get the page
// around it read.
const fromTopFrame = (sender) => !sender || !sender.tab || sender.frameId === 0;

// The one way anything in this file asks the capture policy about a page.
async function verdictFor(url, sender, extra = {}) {
  const settings = await loadSettings();
  return decide({
    url,
    ...policyInput(settings, {
      incognito: !!(sender && sender.tab && sender.tab.incognito === true),
      ...extra,
    }),
  });
}

// Tells the popup what happened to the page in this tab. See outcomes.js.
async function report(sender, url, result) {
  if (!fromExtension(sender) && result && typeof url === 'string') {
    const ok = result.ok === true || result.capture === true;
    await recordOutcome(sender && sender.tab ? sender.tab.id : null, url, { ok, reason: result.reason || (ok ? 'kept' : null) });
  }
  return result;
}

// Only used when a caller does not already know (the ambient path reports it
// on PAGE_CANDIDATE already; the explicit "keep this page now" path does not
// get a candidate message at all, so it has to ask).
async function isPdfTab(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.contentType,
    });
    return result === 'application/pdf';
  } catch {
    return false;
  }
}

// Extraction is injected only once a page has earned it. Putting 90KB of
// parser (or pdf.js's fetch script) into every page a person opens would be
// a strange thing to do to their browser, and most pages never qualify.
export async function injectExtractor(tabId, { explicit = false, isPdf } = {}) {
  if (typeof tabId !== 'number') return false;
  const pdf = typeof isPdf === 'boolean' ? isPdf : await isPdfTab(tabId);
  try {
    if (explicit) {
      // Carried through a global, the same way the quote reaches the
      // highlight script: a content script cannot take arguments.
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          window.__readingArchiveExplicit = true;
        },
      });
    }
    if (pdf) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/content/pdf-fetch.js'],
      });
    } else {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/vendor/readability/Readability.js', 'src/content/extract.js'],
      });
    }
    return true;
  } catch {
    // A tab that navigated away, or a page the extension has no access to.
    // Nothing to recover: the next visit will offer the page again.
    return false;
  }
}

export async function onPageCandidate(payload, sender) {
  if (!payload || typeof payload.url !== 'string') return { capture: false, reason: 'no address' };
  // The same rule as the text itself: a page reports on its own address.
  if (!fromExtension(sender) && (!fromTopFrame(sender) || !sameOrigin(payload.url, senderUrl(sender)))) {
    return { capture: false, reason: 'the address does not match the page that sent it' };
  }
  const verdict = await verdictFor(payload.url, sender, {
    hasPasswordField: payload.hasPasswordField === true,
  });
  if (!verdict.capture) return report(sender, payload.url, verdict);

  const read = isRead({
    focusedMs: payload.focusedMs,
    scrollDepth: payload.scrollDepth,
    wordCount: payload.wordCount,
    isPdf: payload.isPdf,
  });
  if (!read) return { capture: false, reason: 'still reading' };

  const injected = await injectExtractor(sender && sender.tab ? sender.tab.id : null, {
    isPdf: payload.isPdf,
  });
  if (!injected) {
    return report(sender, payload.url, { capture: false, reason: 'the page could not be read' });
  }
  return { capture: true, reason: 'read' };
}

// A content script reports its own address, and a page that compromised its
// renderer could report any address it liked: filing invented text under
// your bank's domain, or getting around an exclusion by naming a different
// site. So text arriving from a page has to come from the origin it claims,
// and is held to the capture policy again on arrival, which also catches a
// pause or an exclusion added between "worth keeping" and the text itself.
function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

async function refusedFromPage(payload, sender) {
  // The extension's own pages are not a page reporting on itself, and are
  // trusted the way the rest of the worker trusts them.
  if (fromExtension(sender)) return null;
  if (!fromTopFrame(sender) || !sameOrigin(payload.url, senderUrl(sender))) {
    return { ok: false, reason: 'the address does not match the page that sent it' };
  }
  const verdict = await verdictFor(payload.url, sender, {
    hasPasswordField: payload.hasPasswordField === true,
  });
  return verdict.capture ? null : { ok: false, reason: verdict.reason };
}

// A page may name a canonical address, and when it is the same page spelled
// more tidily the page is filed under it; see canonicalFor. The policy judged
// the address the page was read at, so the canonical one is judged too: it
// can drop a parameter, and must not be an address a key check or a rule
// refuses. Refused, the page keeps its own.
async function filingUrl(payload, sender) {
  const candidate = canonicalFor(payload.url, payload.canonicalUrl);
  if (candidate === payload.url) return payload.url;
  const verdict = await verdictFor(candidate, sender);
  return verdict.capture ? candidate : payload.url;
}

// Out of disk is cleared the moment a page saves again, or the warning would
// outlive the problem for ever.
async function clearStorageFull() {
  const { storageFull } = await chrome.storage.local.get('storageFull').catch(() => ({}));
  if (!storageFull) return;
  await chrome.storage.local.remove('storageFull').catch(() => {});
  await refreshBadge().catch(() => {});
}

// The date a page was read is the worker's to decide within reason: a
// page's own clock, or a claimed date in the future, is not trusted.
const readAt = (claimed) =>
  Number.isFinite(claimed) && claimed > 0 ? Math.min(claimed, Date.now()) : Date.now();

export async function onPageContent(payload, sender = null) {
  if (!payload || typeof payload.url !== 'string') return { ok: false, reason: 'no address' };
  return report(sender, payload.url, await storePageContent(payload, sender));
}

async function storePageContent(payload, sender) {
  const refused = await refusedFromPage(payload, sender);
  if (refused) return refused;
  const url = await filingUrl(payload, sender);
  return withStore(async (store) => {
    // The cap is on stored text, not on what was extracted, so a very long
    // page is truncated rather than refused.
    const text = truncateUtf8(payload.text, MAX_TEXT_BYTES);
    if (!text.trim()) return { ok: false, reason: 'nothing to index' };
    const title = String(payload.title || '').slice(0, 1000);
    const trimmed = text.trim();
    if (
      !payload.explicit &&
      (trimmed.length < MIN_TEXT_CHARS || trimmed.length < title.length + MIN_TEXT_OVER_TITLE)
    ) {
      return { ok: false, reason: 'too little text to be worth finding later' };
    }

    // A page you already have coming back much smaller is usually a paywall,
    // a consent wall or a takedown stub rather than an edit. Keeping what was
    // read and counting the visit is the only version of this that does not
    // quietly lose the pages most worth having. See core/content-change.js.
    const existing = await store.getPageByUrl(url);
    if (
      existing &&
      isSuspiciousShrink({
        existingText: existing.text || '',
        incomingText: text,
        explicit: !!payload.explicit,
      })
    ) {
      // Handing back the text already stored makes the content hash match, so
      // the store takes its ordinary revisit path: date and visit count move,
      // nothing is reindexed.
      const result = await store.putPage({
        url,
        title: existing.title || '',
        text: existing.text,
        lastSeen: readAt(payload.capturedAt),
      });
      await clearStorageFull();
      return { ok: true, ...result, keptOlderVersion: true };
    }

    try {
      const result = await store.putPage({
        url,
        title,
        text,
        lastSeen: readAt(payload.capturedAt),
      });
      await clearStorageFull();
      return { ok: true, ...result };
    } catch (error) {
      // Out of disk is the one storage failure somebody can act on, so it is
      // the one that gets said out loud instead of being swallowed as a page
      // that silently was not kept.
      if (!isQuotaError(error)) throw error;
      await chrome.storage.local.set({ storageFull: { at: Date.now() } });
      await refreshBadge().catch(() => {});
      return { ok: false, reason: 'there is no room left on this disk', quota: true };
    }
  });
}

// document.title reads empty on Chrome's native PDF viewer, but Chrome's own
// tab title does not: it already carries the PDF's metadata title, checked
// by testing rather than assumed, so this asks Chrome
// instead of pdf.js. A PDF with no title of its own falls back to its
// filename rather than showing nothing in search results.
async function pdfTitle(payload, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (tab && tab.title) return tab.title;
  if (payload.title) return payload.title;
  try {
    const last = new URL(payload.url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last.replace(/\.pdf$/i, ''));
  } catch {
    return '';
  }
}

// content/pdf-fetch.js hands over bytes rather than text: everything from
// here on is identical to an HTML page, so this turns bytes into text and
// then calls the exact same function an HTML page's PAGE_CONTENT does,
// rather than duplicating the shrink-detection, dedupe and quota handling
// above.
export async function onPdfBytes(payload, sender) {
  if (!payload || typeof payload.url !== 'string') return { ok: false, reason: 'no address' };
  return report(sender, payload.url, await pdfToPage(payload, sender));
}

async function pdfToPage(payload, sender) {
  // Checked before pdf.js is spent on the bytes, not only after.
  const refused = await refusedFromPage(payload, sender);
  if (refused) return refused;
  if (!payload.ok) {
    return { ok: false, reason: payload.reason || 'could not read this pdf' };
  }

  // Base64 from content/pdf-fetch.js; a plain array of numbers from older
  // builds and the tests that hand bytes over directly.
  const source = typeof payload.base64 === 'string'
    ? { base64: payload.base64 }
    : Array.isArray(payload.bytes) ? { bytes: payload.bytes } : null;
  if (!source) return { ok: false, reason: 'could not read this pdf' };
  if ((source.base64 ? source.base64.length * 0.75 : source.bytes.length) > MAX_PDF_BYTES) {
    return { ok: false, reason: 'this pdf is too large to keep (over 20MB)' };
  }
  const extracted = await extractPdfText(source);
  if (!extracted.ok) {
    // A corrupted or encrypted file. A scanned, image-only PDF is not this:
    // pdf.js succeeds and returns empty text, which onPageContent's own
    // "too little text" floor already catches with the same message an
    // empty HTML extraction gets.
    return { ok: false, reason: 'could not read this pdf' };
  }

  return onPageContent({
    url: payload.url,
    title: await pdfTitle(payload, sender),
    text: extracted.text,
    capturedAt: payload.capturedAt,
    explicit: payload.explicit,
  }, sender);
}
