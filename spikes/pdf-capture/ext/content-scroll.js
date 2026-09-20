(() => {
  const report = (obj) => console.log('SCROLL_RESULT ' + JSON.stringify(obj));
  window.__spikeScrollLog = [];

  const snapshot = (label) => ({
    label,
    href: location.href,
    scrollY: window.scrollY,
    docScrollHeight: document.documentElement ? document.documentElement.scrollHeight : null,
    bodyChildCount: document.body ? document.body.children.length : null,
    iframeCount: document.querySelectorAll('iframe').length,
    embedCount: document.querySelectorAll('embed').length,
  });

  report(snapshot('start'));

  window.addEventListener('scroll', () => report(snapshot('scroll-event')), { passive: true });

  window.addEventListener('load', () => {
    report(snapshot('load'));
    // Try to actually see inside any embed/iframe the viewer uses.
    for (const el of document.querySelectorAll('iframe, embed')) {
      try {
        const doc2 = el.contentDocument;
        report({ label: 'child-doc-access', tag: el.tagName, accessible: !!doc2 });
      } catch (e) {
        report({ label: 'child-doc-access', tag: el.tagName, accessible: false, error: String(e) });
      }
    }
  });

  window.__spikeForceScroll = (y) => { window.scrollTo(0, y); return window.scrollY; };
})();
