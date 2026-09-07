// Scrolls to a remembered passage and marks it, for the two cases a text
// fragment cannot handle: a tab that is already open on the page, and a page
// whose content arrives after load. The spike in spikes/text-fragment
// established both.
//
// Injected on demand with the quote in a global, because a content script
// cannot take arguments and this file has no imports to take them through.
//
// The page is not modified. The Custom Highlight API paints a range without
// wrapping anything in a span, which matters: wrapping text in elements
// breaks pages that are watching their own DOM, and this extension has no
// business rearranging someone else's article.

(() => {
  const quote = window.__snowMountainQuote;
  const onlyIfUnscrolled = window.__snowMountainOnlyIfUnscrolled === true;
  delete window.__snowMountainQuote;
  delete window.__snowMountainOnlyIfUnscrolled;
  if (!quote) return;

  // The fragment already did the job, so leave the page where it is.
  if (onlyIfUnscrolled && window.scrollY > 0) return;

  const MIN_WORDS = 4;

  function normalise(text) {
    const chars = [];
    const map = [];
    let lastWasSpace = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (/\s/.test(char)) {
        if (lastWasSpace || chars.length === 0) continue;
        chars.push(' ');
        map.push(i);
        lastWasSpace = true;
      } else {
        chars.push(char.toLowerCase());
        map.push(i);
        lastWasSpace = false;
      }
    }
    return { text: chars.join(''), map };
  }

  // Kept in step with src/core/quote-match.js, which is where this logic is
  // tested. A content script cannot import it without a build step.
  function locateQuote(haystack, needleText) {
    if (!haystack || !needleText) return null;
    const exact = haystack.indexOf(needleText);
    if (exact !== -1) return { start: exact, end: exact + needleText.length };

    const hay = normalise(haystack);
    const needle = normalise(needleText).text.trim();
    if (!needle) return null;

    const loose = hay.text.indexOf(needle);
    if (loose !== -1) {
      return {
        start: hay.map[loose],
        end: hay.map[Math.min(loose + needle.length - 1, hay.map.length - 1)] + 1,
      };
    }

    const words = needle.split(' ');
    for (let length = words.length - 1; length >= MIN_WORDS; length--) {
      const found = hay.text.indexOf(words.slice(0, length).join(' '));
      if (found !== -1) {
        const partialLength = words.slice(0, length).join(' ').length;
        return {
          start: hay.map[found],
          end: hay.map[Math.min(found + partialLength - 1, hay.map.length - 1)] + 1,
        };
      }
    }
    return null;
  }

  // Flatten the visible text, remembering which node each character came
  // from, so an offset in the flattened string can become a DOM Range.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const pieces = [];
  const nodes = [];
  let total = 0;
  let node = walker.nextNode();
  while (node) {
    pieces.push(node.nodeValue);
    nodes.push({ node, start: total, end: total + node.nodeValue.length });
    total += node.nodeValue.length;
    node = walker.nextNode();
  }

  const hit = locateQuote(pieces.join(''), quote);
  if (!hit) return;

  const startNode = nodes.find((entry) => hit.start >= entry.start && hit.start < entry.end);
  const endNode = nodes.find((entry) => hit.end > entry.start && hit.end <= entry.end) ||
    nodes[nodes.length - 1];
  if (!startNode || !endNode) return;

  const range = document.createRange();
  range.setStart(startNode.node, hit.start - startNode.start);
  range.setEnd(endNode.node, Math.min(hit.end - endNode.start, endNode.node.nodeValue.length));

  const target = range.startContainer.parentElement;
  if (target && target.scrollIntoView) {
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
  }

  // Paint it, without touching the document's own nodes.
  if (window.CSS && CSS.highlights && window.Highlight) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('::highlight(snow-mountain){background:#fde68a;color:inherit}');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    CSS.highlights.set('snow-mountain', new Highlight(range));

    setTimeout(() => {
      CSS.highlights.delete('snow-mountain');
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    }, 6000);
  }
})();
