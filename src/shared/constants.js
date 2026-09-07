// The display name lives here and nowhere else, so renaming the project
// stays a one line change. See the naming section of BRIEF.md.
export const DISPLAY_NAME = 'Snow Mountain';

export const DB_NAME = 'archive';
export const DB_VERSION = 1;

// Postings are chunked by document id. 256 documents per bucket, chosen by
// measurement rather than by feel: at 4096 the record for a term grew with
// every page added to the same bucket, and since indexing one article
// rewrites roughly 550 term records, cost per page climbed from 132ms to
// 297ms between 400 and 1500 documents and was heading for a second. At 256
// the rewrite is bounded, indexing stays near 130ms, and storage came out
// 26% smaller. See test/browser/run-benchmark.mjs.
//
// Changing this invalidates every existing index, so it is a migration and
// not a tweak.
export const BUCKET_SHIFT = 8;

// Positions per term per document. Enough for phrase queries in practice,
// and it stops one pathological document from bloating the index.
export const MAX_POSITIONS_PER_TERM = 32;

export const MAX_TEXT_BYTES = 200 * 1024;

export const BM25 = { k1: 1.2, b: 0.75 };

export const DEFAULTS = {
  retentionMonths: 12,
  sizeCapBytes: 500 * 1024 * 1024,
  warnAtFraction: 0.8,
  dwellMs: 9000,
  scrollDepth: 0.35,
  shortPageWords: 400,
};
