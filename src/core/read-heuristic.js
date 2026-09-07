// Deciding what counts as "read". Indexing every URL that ever loaded
// produces a landfill, so a page has to earn its place.
//
// Pure on purpose: the content script is a sensor that reports numbers,
// and the judgement lives here where it can be tested.

import { DEFAULTS } from '../shared/constants.js';

export function isRead(
  { focusedMs = 0, scrollDepth = 0, wordCount = 0 },
  cfg = DEFAULTS
) {
  if (focusedMs < cfg.dwellMs) return false;
  // Short pages never needed scrolling, so requiring it would lose them.
  if (wordCount > 0 && wordCount <= cfg.shortPageWords) return true;
  return scrollDepth >= cfg.scrollDepth;
}
