// The first real use of the offscreen document ARCHITECTURE.md reserved:
// pdf.js needs its own Worker, and a service worker cannot reliably spawn
// one (see ARCHITECTURE.md's assumption log). Created on demand by
// background/pdf-extract.js, closed again after a short idle window, never
// touches the database -- it only turns bytes into text and hands the
// answer back.

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { MSG } from '../shared/messages.js';
import { MAX_TEXT_BYTES } from '../shared/constants.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('src/vendor/pdfjs/pdf.worker.min.mjs');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== MSG.PARSE_PDF) return false;

  (async () => {
    try {
      const data = new Uint8Array(message.payload.bytes);
      // isEvalSupported: false is what makes the extension's real CSP
      // (no unsafe-eval) enough: it disables the one path, executing
      // embedded PDF JavaScript for form calculations, that would need
      // Function()/eval, and capture has no reason to run PDF forms.
      const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
      let text = '';
      // onPageContent truncates stored text to MAX_TEXT_BYTES regardless, so
      // a document with far more pages than that ever needs stops here
      // rather than paying full pdf.js extraction cost for pages whose text
      // would only be thrown away. Measured against a 12,000 page fixture:
      // parsing every page took 38.6s of a 47.5s total capture, almost all
      // of it text nobody was ever going to see. See PDF-CAPTURE.md.
      for (let i = 1; i <= doc.numPages && text.length < MAX_TEXT_BYTES; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map((item) => item.str).join(' ') + '\n';
      }
      // Title deliberately does not come from here. doc.getMetadata() throws
      // inside this pdfjs-dist build ("getOrInsertComputed is not a
      // function", a Map method this Chromium does not have) on a code path
      // shared with unrelated editor/telemetry modules -- found by testing,
      // not assumed. capture.js gets the title from chrome.tabs instead,
      // which turns out to already have it correctly and does not depend on
      // pdf.js at all. See PDF-CAPTURE.md.
      sendResponse({ ok: true, text: text.trim(), numPages: doc.numPages });
    } catch (error) {
      // A scanned, image-only PDF has no text layer and getTextContent()
      // returns nothing; that is not an error and is handled by the caller
      // the same way a non-article HTML page is. This catch is for pdf.js
      // actually failing: a corrupted file, an encrypted one, truncated
      // bytes.
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    }
  })();

  return true;
});
