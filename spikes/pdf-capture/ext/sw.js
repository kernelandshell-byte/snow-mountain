self.addEventListener('install', () => self.skipWaiting());

let creating = null;
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  if (creating) { await creating; return; }
  creating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Parse PDF bytes with pdf.js off the service worker thread.',
  });
  await creating;
  creating = null;
}

// Exposed for Playwright to call directly on the service worker.
self.parsePdfBytes = async (bytesArray) => {
  await ensureOffscreen();
  return await chrome.runtime.sendMessage({ type: 'PARSE_PDF', bytes: bytesArray });
};
