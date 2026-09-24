// What happened the last time a tab offered its page, so the popup can say
// something true about it.
//
// The capture policy can only judge an address from the popup. Whether the
// page itself had a password field, too little text, or an extraction that
// failed is only known once the tab has reported, and that report goes to
// the worker, not to the popup. Without this, a page refused for any of those
// reasons read as "Not kept yet" for ever, and "Keep this page now" appeared
// to do nothing.
//
// Kept in chrome.storage.session: in memory only, never written to disk,
// gone when the browser closes, and not readable by content scripts.

import { urlKey } from '../core/url-key.js';

const keyFor = (tabId) => 'outcome:' + tabId;

// Refusals that come from settings rather than from the page: a pause, an
// exclusion, the allowlist, setup. The popup works those out afresh from the
// current settings every time it opens, so remembering them could only ever
// be stale -- "paused" still showing after a resume.
const FROM_SETTINGS = /^(paused|incognito|setup is not finished|not on your allowlist|excluded|the address contains|not a web page|unparseable url)/;

export async function recordOutcome(tabId, url, { ok, reason }) {
  if (typeof tabId !== 'number' || !chrome.storage.session) return;
  if (!ok && FROM_SETTINGS.test(reason || '')) return;
  const entry = { key: urlKey(url), ok: !!ok, reason: reason || null, at: Date.now() };
  await chrome.storage.session.set({ [keyFor(tabId)]: entry }).catch(() => {});
}

export async function readOutcome(tabId, url) {
  if (typeof tabId !== 'number' || !chrome.storage.session) return null;
  const stored = await chrome.storage.session.get(keyFor(tabId)).catch(() => ({}));
  const entry = stored && stored[keyFor(tabId)];
  if (!entry || entry.key !== urlKey(url)) return null;
  return entry;
}

export async function forgetOutcome(tabId) {
  if (!chrome.storage.session) return;
  await chrome.storage.session.remove(keyFor(tabId)).catch(() => {});
}
