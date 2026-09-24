// Finding a remembered sentence in a page that has moved on since it was
// captured. Pure, so the awkward part is testable without a browser: the
// DOM walking in content/highlight.js is thin on top of this.
//
// Three attempts, in order of how much they trust the stored text:
//   1. the quote exactly as stored
//   2. the quote with whitespace and case ignored, which covers reflowed
//      markup, a changed line break, a capitalised first word
//   3. progressively shorter openings of the quote, which covers an edited
//      sentence whose beginning survived

const MIN_WORDS = 4;

// Collapses runs of whitespace and lowercases, keeping a map back to the
// original offsets so a match can be reported in the caller's coordinates.
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

export function locateQuote(haystack, quote) {
  if (!haystack || !quote) return null;

  const exact = haystack.indexOf(quote);
  if (exact !== -1) return { start: exact, end: exact + quote.length, how: 'exact' };

  const hay = normalise(haystack);
  const needle = normalise(quote).text.trim();
  if (!needle) return null;

  const loose = hay.text.indexOf(needle);
  if (loose !== -1) {
    return {
      start: hay.map[loose],
      end: hay.map[Math.min(loose + needle.length - 1, hay.map.length - 1)] + 1,
      how: 'loose',
    };
  }

  // The sentence was edited. Its opening is the part most likely to survive,
  // so try shorter and shorter openings before giving up.
  const words = needle.split(' ');
  for (let length = words.length - 1; length >= MIN_WORDS; length--) {
    const partial = words.slice(0, length).join(' ');
    const found = hay.text.indexOf(partial);
    if (found !== -1) {
      return {
        start: hay.map[found],
        end: hay.map[Math.min(found + partial.length - 1, hay.map.length - 1)] + 1,
        how: 'partial',
      };
    }
  }

  return null;
}
