// Owns the offscreen document's lifecycle: created on demand for the first
// PDF candidate, kept alive briefly for the next one, closed again once
// nothing has asked for it -- the service worker's own "dies constantly,
// holds nothing important" ethos extended to its one helper process.
//
// chrome.alarms rather than setTimeout, because a suspended service worker
// drops timers but not alarms. chrome.alarms has a real floor of about a
// minute for a published extension, which is why the idle window is a
// minute rather than the 30 seconds an earlier draft of PDF-CAPTURE.md
// proposed before this was actually built against the real API.

import { MSG } from '../shared/messages.js';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
export const OFFSCREEN_IDLE_ALARM = 'closeOffscreenPdf';
const OFFSCREEN_IDLE_MINUTES = 1;

let creating = null;
async function ensureOffscreenDocument() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS'],
    justification: 'Parse PDF bytes with pdf.js off the service worker thread.',
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

export async function closeOffscreenIfIdle() {
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (has) await chrome.offscreen.closeDocument().catch(() => {});
}

export async function extractPdfText(bytes) {
  await ensureOffscreenDocument();
  chrome.alarms.create(OFFSCREEN_IDLE_ALARM, { delayInMinutes: OFFSCREEN_IDLE_MINUTES });
  try {
    const result = await chrome.runtime.sendMessage({ type: MSG.PARSE_PDF, payload: { bytes } });
    return result || { ok: false, error: 'no response from the offscreen document' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}
