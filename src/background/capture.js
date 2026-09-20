// Everything on the path from "a tab says it was read" to "a page is in the
// archive". The judgement lives here; the content script only measures.

import {
  MAX_TEXT_BYTES, MIN_TEXT_CHARS, MIN_TEXT_OVER_TITLE,
} from '../shared/constants.js';
import { decide } from '../core/capture-policy.js';
import { isRead } from '../core/read-heuristic.js';
import { isSuspiciousShrink } from '../core/content-change.js';
import { loadSettings, isPaused } from '../shared/settings.js';
import { rulesFor } from '../shared/presets.js';
import { isQuotaError } from '../db/idb-store.js';
import { getStore, withStore } from './store-handle.js';
import { extractPdfText } from './pdf-extract.js';

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
    isPdf: payload.isPdf,
  });
  if (!read) return { capture: false, reason: 'still reading' };

  const injected = await injectExtractor(sender && sender.tab ? sender.tab.id : null, {
    isPdf: payload.isPdf,
  });
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

export async function onPageContent(payload) {
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

    const url = preferredUrl(payload.url, payload.canonicalUrl);

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
        lastSeen: payload.capturedAt || Date.now(),
      });
      return { ok: true, ...result, keptOlderVersion: true };
    }

    try {
      const result = await store.putPage({
        url,
        title: payload.title || '',
        text,
        lastSeen: payload.capturedAt || Date.now(),
      });
      return { ok: true, ...result };
    } catch (error) {
      // Out of disk is the one storage failure somebody can act on, so it is
      // the one that gets said out loud instead of being swallowed as a page
      // that silently was not kept.
      if (!isQuotaError(error)) throw error;
      await chrome.storage.local.set({ storageFull: { at: Date.now() } });
      await chrome.action.setBadgeText({ text: '!' }).catch(() => {});
      await chrome.action.setBadgeBackgroundColor({ color: '#b45309' }).catch(() => {});
      return { ok: false, reason: 'there is no room left on this disk', quota: true };
    }
  });
}

// document.title reads empty on Chrome's native PDF viewer, but Chrome's own
// tab title does not: it already carries the PDF's metadata title, checked
// by testing rather than assumed (see PDF-CAPTURE.md), so this asks Chrome
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
// above. See PDF-CAPTURE.md.
export async function onPdfBytes(payload, sender) {
  if (!payload.ok) {
    return { ok: false, reason: payload.reason || 'could not read this pdf' };
  }

  const extracted = await extractPdfText(payload.bytes);
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
  });
}
