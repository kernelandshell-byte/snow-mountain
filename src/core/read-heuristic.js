// Deciding what counts as "read". Indexing every URL that ever loaded
// produces a landfill, so a page has to earn its place.
//
// Pure on purpose: the content script is a sensor that reports numbers,
// and the judgement lives here where it can be tested.

import { DEFAULTS } from '../shared/constants.js';

export function isRead(
  { focusedMs = 0, scrollDepth = 0, wordCount = 0, isPdf = false },
  cfg = DEFAULTS
) {
  if (focusedMs < cfg.dwellMs) return false;
  // A PDF's scroll position lives inside Chrome's native viewer, which is
  // opaque to a content script: no real scrollHeight, no scroll events,
  // nothing. Dwell is the only signal that exists for a PDF, so it is the
  // only one required. This has to be an explicit branch on a signal the
  // content script actually measured (contentType), not an accident of the
  // numbers below: a PDF tab's wordCount is exactly 0 (document.body.innerText
  // sees the opaque viewer, not the document), which fails the short-page
  // check's `> 0` rather than satisfying it, and a PDF tab's scrollDepth
  // already reads 1 by coincidence (the viewer's embed pins scrollHeight to
  // the viewport), which would work today by accident and stop working the
  // moment that coincidence didn't hold. See PDF-CAPTURE.md.
  if (isPdf) return true;
  // Short pages never needed scrolling, so requiring it would lose them.
  if (wordCount > 0 && wordCount <= cfg.shortPageWords) return true;
  return scrollDepth >= cfg.scrollDepth;
}
