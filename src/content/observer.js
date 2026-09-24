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
  const MAX_GAP_MS = 60000;

  let focusedMs = 0;
  let maxScroll = 0;
  let lastTick = Date.now();
  let offered = false;
  let captured = false;
  // How often a page that is still being read is asked about again. Every
  // offer walks the page for secret fields, so a long article left open and
  // unscrolled all afternoon must not do that every few seconds. Scrolling
  // further is new information and brings the next offer forward.
  let offers = 0;
  let nextOfferAt = 0;
  let scrollAtOffer = 0;
  // The address without its fragment. Jumping to #section-2 is the same page
  // read further down, and the archive files both under one address anyway;
  // treating it as a new page only re-extracted it and counted a visit that
  // never happened.
  const pageAddress = () => location.href.split('#')[0];
  let currentUrl = pageAddress();

  const scrollDepth = () => {
    const doc = document.documentElement;
    if (doc.scrollHeight - window.innerHeight <= 0) return 1;
    return Math.min(1, (window.scrollY + window.innerHeight) / doc.scrollHeight);
  };

  // Whether the page asks for something secret: a password, a card number,
  // a one-time code, an account number. Looks inside open shadow roots and
  // same-origin frames too, and treats an embedded payment form from a
  // known provider as one, since its fields live in a frame this script
  // cannot see into. Kept identical in observer.js and extract.js, which
  // cannot share code without a build step.
  const SENSITIVE_AUTOCOMPLETE =
    /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|cc-name)(\s|$)/i;
  const SENSITIVE_NAME =
    /(^|[^a-z])(password|passwd|pwd|cvv2?|cvc|csc|iban|ccnum|cc-?number|card-?num(ber)?|cardnumber|ssn|routing-?num(ber)?|account-?num(ber)?|acct-?num(ber)?|otp|one-?time-?code)([^a-z]|$)/i;
  const PAYMENT_FRAME =
    /^https:\/\/([a-z0-9-]+\.)*(js\.stripe\.com|checkout\.stripe\.com|braintreegateway\.com|braintree-api\.com|adyen\.com|paypal\.com|checkoutshopper-live\.adyen\.com|pay\.google\.com|squareup\.com|squarecdn\.com|recurly\.com|chargebee\.com|klarna\.com|mollie\.com)\//i;

  // userPassword, ibanInput and card_number read as separate words, so the
  // name pattern can find them without matching inside ordinary words.
  const splitWords = (text) => text.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-');

  const fieldIsSensitive = (input) =>
    (input.type || '').toLowerCase() === 'password' ||
    SENSITIVE_AUTOCOMPLETE.test(input.getAttribute('autocomplete') || '') ||
    SENSITIVE_NAME.test(splitWords((input.name || '') + ' ' + (input.id || '')));

  // Stripe.js adds hidden helper frames to every page that loads it, and
  // PayPal's buttons and pay-later messages sit on ordinary product pages.
  // Neither is a form anybody is filling in, so only a visible frame counts,
  // and not those two.
  const NOT_A_PAYMENT_FORM =
    /^https:\/\/([a-z0-9-]+\.)*(js\.stripe\.com\/v\d+\/(controller|m-outer|metrics)|paypal\.com\/(smart\/buttons\b|credit-presentment\/))/i;
  const isPaymentForm = (frame) => {
    const src = frame.src || '';
    if (!PAYMENT_FRAME.test(src) || NOT_A_PAYMENT_FORM.test(src)) return false;
    const rect = frame.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 10) return false;
    const view = (frame.ownerDocument && frame.ownerDocument.defaultView) || window;
    const style = view.getComputedStyle(frame);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const hasSensitiveField = (root = document, depth = 0) => {
    if (!root || depth > 3) return false;
    for (const input of root.querySelectorAll('input')) {
      if (fieldIsSensitive(input)) return true;
    }
    for (const frame of root.querySelectorAll('iframe')) {
      if (isPaymentForm(frame)) return true;
      let inner = null;
      try { inner = frame.contentDocument; } catch { inner = null; }
      if (inner && hasSensitiveField(inner, depth + 1)) return true;
    }
    // Open shadow roots, bounded so a huge page does not pay for a full walk.
    let seen = 0;
    for (const element of root.querySelectorAll('*')) {
      if (++seen > 5000) break;
      if (element.shadowRoot && hasSensitiveField(element.shadowRoot, depth + 1)) return true;
    }
    return false;
  };

  const hasPasswordField = () => hasSensitiveField();

  // Chrome's native PDF viewer renders on top of the original PDF URL rather
  // than navigating away from it, so this content script still runs and
  // this is a free, reliable way to tell the two apart.
  const isPdf = () => document.contentType === 'application/pdf';

  // innerText forces layout, and this runs on every page the person opens,
  // so the answer is cached. It only has to be roughly right: it decides
  // whether a page is short enough to excuse not scrolling.
  let cachedWords = 0;
  let cachedAt = 0;
  const wordCount = () => {
    const now = Date.now();
    if (now - cachedAt < 15000 && cachedWords) return cachedWords;
    const text = document.body ? document.body.innerText : '';
    cachedWords = text ? text.split(/\s+/).length : 0;
    cachedAt = now;
    return cachedWords;
  };

  function reset() {
    focusedMs = 0;
    maxScroll = 0;
    lastTick = Date.now();
    offered = false;
    captured = false;
    offers = 0;
    nextOfferAt = 0;
    scrollAtOffer = 0;
    cachedWords = 0;
    cachedAt = 0;
    currentUrl = pageAddress();
  }

  async function offer() {
    if (offered) return;
    // Marked before awaiting, so a slow round trip cannot let a second offer
    // through and capture the page twice.
    offered = true;
    offers += 1;
    scrollAtOffer = maxScroll;
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
          isPdf: isPdf(),
        },
      })
      .catch(() => null);

    // "Still reading" is not a refusal, so a later tick tries again: soon at
    // first, while the reading thresholds are close, then less and less often.
    if (!reply || (!reply.capture && reply.reason === 'still reading')) {
      offered = false;
      nextOfferAt = focusedMs + Math.min(MAX_GAP_MS, TICK_MS * 2 ** Math.max(0, offers - 2));
    } else {
      captured = true;
    }
  }

  setInterval(() => {
    // An SPA route change is a new page even though nothing navigated, and
    // it is the only thing worth checking once this page has been decided.
    if (pageAddress() !== currentUrl) {
      reset();
      return;
    }
    if (captured) return;

    const now = Date.now();
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      focusedMs += now - lastTick;
    }
    lastTick = now;
    maxScroll = Math.max(maxScroll, scrollDepth());
    if (maxScroll - scrollAtOffer >= 0.05) nextOfferAt = 0;

    if (focusedMs >= FLOOR_MS && focusedMs >= nextOfferAt) offer();
  }, TICK_MS);

  window.addEventListener(
    'scroll',
    () => {
      maxScroll = Math.max(maxScroll, scrollDepth());
    },
    { passive: true }
  );
})();
