// Corpus statistics are passed in rather than read, so scoring stays pure
// and the relevance harness can tune k1 and b without touching storage.

import { BM25 } from '../shared/constants.js';

export function idf(df, docCount) {
  return Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
}

export function termScore({ tf, df, docLength }, { docCount, avgDocLength }, params = BM25) {
  const { k1, b } = params;
  const norm = 1 - b + b * (docLength / (avgDocLength || 1));
  return idf(df, docCount) * ((tf * (k1 + 1)) / (tf + k1 * norm));
}

// Mild logarithmic recency preference. Strong enough to break ties in
// favour of what you read recently, weak enough that a perfect old match
// still beats a poor new one.
export function recencyBoost(lastSeen, now = Date.now()) {
  const days = Math.max(0, (now - lastSeen) / 86400000);
  return 1 + 0.15 / Math.log2(days + 4);
}
