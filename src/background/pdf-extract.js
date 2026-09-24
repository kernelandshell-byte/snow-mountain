// Owns the offscreen document's lifecycle: created on demand for the first
// PDF candidate, kept alive briefly for the next one, closed again once
// nothing has asked for it -- the service worker's own "dies constantly,
// holds nothing important" ethos extended to its one helper process.
//
// chrome.alarms rather than setTimeout, because a suspended service worker
// drops timers but not alarms. chrome.alarms has a real floor of about a
// minute for a published extension, which is why the idle window is a
// minute rather than 30 seconds.

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

// PDFs being parsed right now. A large file can take longer than the idle
// window, and closing the document under it would fail a capture that was
// going fine. The worker stays alive while it waits on the reply, so a count
// in memory is enough.
let inFlight = 0;

const armIdleAlarm = () =>
  chrome.alarms.create(OFFSCREEN_IDLE_ALARM, { delayInMinutes: OFFSCREEN_IDLE_MINUTES });

export async function closeOffscreenIfIdle() {
  if (inFlight > 0) {
    armIdleAlarm();
    return;
  }
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (has) await chrome.offscreen.closeDocument().catch(() => {});
}

// `source` is { base64 } or { bytes }, passed through as it came.
export async function extractPdfText(source) {
  inFlight += 1;
  try {
    await ensureOffscreenDocument();
    const result = await chrome.runtime.sendMessage({ type: MSG.PARSE_PDF, payload: source });
    return result || { ok: false, error: 'no response from the offscreen document' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    inFlight -= 1;
    armIdleAlarm();
  }
}
