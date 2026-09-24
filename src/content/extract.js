// Injected on demand, once the service worker has decided a page is worth
// keeping. Runs Readability over a clone of the document, because Readability
// rewrites what it is given and the page the reader is looking at should not
// change underneath them.
//
// A classic script on purpose: content scripts cannot use ES modules without
// a bundler, and this project has no build step.

(() => {
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

  const cleanup = (text) =>
    text
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  let article = null;
  try {
    // charThreshold below the default, because short posts are worth keeping
    // and the default is tuned for news articles.
    article = new Readability(document.cloneNode(true), { charThreshold: 250 }).parse();
  } catch {
    article = null;
  }

  // Readability returns null when a page is not article shaped at all, which
  // is common and not an error: documentation, forums, dashboards. The
  // fallback keeps those searchable, at the cost of some navigation noise.
  const text = cleanup(
    article && article.textContent ? article.textContent : document.body ? document.body.innerText : ''
  );

  const canonical = document.querySelector('link[rel="canonical"]');
  const explicit = window.__readingArchiveExplicit === true;
  delete window.__readingArchiveExplicit;

  chrome.runtime.sendMessage({
    type: 'PAGE_CONTENT',
    payload: {
      url: location.href,
      canonicalUrl: canonical ? canonical.href : null,
      title: (article && article.title) || document.title || '',
      text,
      excerpt: (article && article.excerpt) || '',
      extractedBy: article ? 'readability' : 'fallback',
      explicit,
      capturedAt: Date.now(),
      // Checked again now, not only when the page was first judged worth
      // keeping: a login form or a payment step can appear after load.
      hasPasswordField: hasSensitiveField(),
    },
  }).catch(() => {
    // The worker was restarting. The next visit offers the page again.
  });
})();
