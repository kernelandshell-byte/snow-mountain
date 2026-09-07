// Intentionally minimal. Playwright evaluates chrome.tabs.* inside this worker.
self.addEventListener('install', () => self.skipWaiting());
