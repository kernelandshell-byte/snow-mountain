// Injected on demand, once the service worker has decided a page is worth
// keeping. Runs Readability over a clone of the document, because Readability
// rewrites what it is given and the page the reader is looking at should not
// change underneath them.
//
// A classic script on purpose: content scripts cannot use ES modules without
// a bundler, and this project has no build step.

(() => {
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

  chrome.runtime.sendMessage({
    type: 'PAGE_CONTENT',
    payload: {
      url: location.href,
      canonicalUrl: canonical ? canonical.href : null,
      title: (article && article.title) || document.title || '',
      text,
      excerpt: (article && article.excerpt) || '',
      extractedBy: article ? 'readability' : 'fallback',
      capturedAt: Date.now(),
    },
  });
})();
