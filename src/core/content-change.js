// What to do when a page you already have comes back different.
//
// The usual case is harmless: an article gains a correction, a docs page gains
// a paragraph, and reindexing is exactly right. One case is not harmless. You
// read something in full, and weeks later the same URL serves you three
// paragraphs and a subscribe button, or a consent wall, or a "this article is
// no longer available" stub. Reindexing that replaces what you read with what
// you are now allowed to read, and the thing this extension exists to do --
// give you back the page you actually read -- quietly stops working for
// exactly the pages most worth keeping.
//
// So a revisit that would replace a substantial page with a much smaller one
// is treated as a revisit and nothing more: the visit is counted, the date is
// updated, and the text that was read is kept. The cost is a page that really
// was shortened staying stale in the index. That is the right way round: a
// stale copy of something you read can still be found, and a lost one cannot.
//
// Not applied when the person explicitly asked to keep the page in front of
// them. At that point they can see what is on the screen and they are telling
// you to keep it.

// A page has to be worth protecting before it is protected. Below this, both
// versions are short enough that neither is really an article and the newer
// one is as good a guess as the older.
export const PROTECT_ABOVE_CHARS = 1000;

// How much smaller counts as "this is not the same page any more". A paywall
// stub is typically a tenth of the article; ordinary editing does not remove
// two thirds of a page.
export const SHRINK_FRACTION = 0.4;

export function isSuspiciousShrink({ existingText = '', incomingText = '', explicit = false } = {}) {
  if (explicit) return false;
  const before = existingText.trim().length;
  const after = incomingText.trim().length;
  if (before < PROTECT_ABOVE_CHARS) return false;
  if (after >= before * SHRINK_FRACTION) return false;
  return true;
}
