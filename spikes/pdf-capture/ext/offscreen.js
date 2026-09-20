import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'PARSE_PDF') return false;
  (async () => {
    try {
      const bytes = new Uint8Array(msg.bytes);
      const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
      let text = '';
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((it) => it.str).join(' ') + '\n';
      }
      sendResponse({ ok: true, numPages: doc.numPages, text: text.trim() });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.stack || e) });
    }
  })();
  return true;
});

chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });
