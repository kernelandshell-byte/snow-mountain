// A sensor, not a decision maker. It measures how the page was actually
// used and reports numbers. Whether any of that counts as reading is
// decided in the service worker, where the rules live in one testable place.
//
// Deliberately a classic script with no imports: content scripts cannot use
// ES modules without a bundler, and v1 has no build step. Keeping the logic
// here trivial is what makes that affordable.

(() => {
  const FLOOR_MS = 5000;
  const TICK_MS = 2500;

  let focusedMs = 0;
  let maxScroll = 0;
  let lastTick = Date.now();
  let reported = false;
  let currentUrl = location.href;

  const scrollDepth = () => {
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - window.innerHeight;
    if (scrollable <= 0) return 1;
    return Math.min(1, (window.scrollY + window.innerHeight) / doc.scrollHeight);
  };

  const hasPasswordField = () => !!document.querySelector('input[type="password"]');

  const wordCount = () => (document.body?.innerText || '').split(/\s+/).length;

  function reset() {
    focusedMs = 0;
    maxScroll = 0;
    lastTick = Date.now();
    reported = false;
    currentUrl = location.href;
  }

  async function offer() {
    if (reported) return;
    const reply = await chrome.runtime.sendMessage({
      type: 'PAGE_CANDIDATE',
      payload: {
        url: location.href,
        title: document.title,
        hasPasswordField: hasPasswordField(),
        focusedMs,
        scrollDepth: maxScroll,
        wordCount: wordCount(),
      },
    }).catch(() => null);

    if (!reply || !reply.capture) return;
    reported = true;

    // TODO(step 5): vendor Readability and extract the article properly.
    // Body innerText is a placeholder so the pipeline can be wired end to end.
    chrome.runtime.sendMessage({
      type: 'PAGE_CONTENT',
      payload: {
        url: location.href,
        title: document.title,
        text: document.body?.innerText || '',
        capturedAt: Date.now(),
      },
    }).catch(() => {});
  }

  setInterval(() => {
    const now = Date.now();
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      focusedMs += now - lastTick;
    }
    lastTick = now;
    maxScroll = Math.max(maxScroll, scrollDepth());

    // An SPA route change is a new page even though nothing navigated.
    if (location.href !== currentUrl) reset();

    if (focusedMs >= FLOOR_MS) offer();
  }, TICK_MS);

  window.addEventListener('scroll', () => {
    maxScroll = Math.max(maxScroll, scrollDepth());
  }, { passive: true });
})();
