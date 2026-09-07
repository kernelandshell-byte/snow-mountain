// A sensor, not a decision maker. It measures how the page was actually used
// and reports numbers. Whether any of that counts as reading is decided in
// the service worker, where the rules live in one testable place, and the
// text is extracted by a separate script that is injected only if the answer
// is yes.
//
// Deliberately a classic script with no imports: content scripts cannot use
// ES modules without a bundler, and v1 has no build step. Keeping this file
// trivial is what makes that affordable.

(() => {
  const FLOOR_MS = 5000;
  const TICK_MS = 2500;

  let focusedMs = 0;
  let maxScroll = 0;
  let lastTick = Date.now();
  let offered = false;
  let currentUrl = location.href;

  const scrollDepth = () => {
    const doc = document.documentElement;
    if (doc.scrollHeight - window.innerHeight <= 0) return 1;
    return Math.min(1, (window.scrollY + window.innerHeight) / doc.scrollHeight);
  };

  const hasPasswordField = () => !!document.querySelector('input[type="password"]');

  const wordCount = () => {
    const text = document.body ? document.body.innerText : '';
    return text ? text.split(/\s+/).length : 0;
  };

  function reset() {
    focusedMs = 0;
    maxScroll = 0;
    lastTick = Date.now();
    offered = false;
    currentUrl = location.href;
  }

  async function offer() {
    if (offered) return;
    // Marked before awaiting, so a slow round trip cannot let a second offer
    // through and capture the page twice.
    offered = true;
    const reply = await chrome.runtime
      .sendMessage({
        type: 'PAGE_CANDIDATE',
        payload: {
          url: location.href,
          title: document.title,
          hasPasswordField: hasPasswordField(),
          focusedMs,
          scrollDepth: maxScroll,
          wordCount: wordCount(),
        },
      })
      .catch(() => null);

    // "Still reading" is not a refusal, so let the next tick try again.
    if (!reply || (!reply.capture && reply.reason === 'still reading')) offered = false;
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

  window.addEventListener(
    'scroll',
    () => {
      maxScroll = Math.max(maxScroll, scrollDepth());
    },
    { passive: true }
  );
})();
