import { BUCKET_SHIFT, MAX_POSITIONS_PER_TERM } from '../shared/constants.js';

export const bucketOf = (docId) => docId >> BUCKET_SHIFT;

// Token list to per term posting entries for one document.
export function buildPostings(tokens) {
  const byTerm = new Map();
  for (const { term, pos } of tokens) {
    let entry = byTerm.get(term);
    if (!entry) {
      entry = { tf: 0, pos: [] };
      byTerm.set(term, entry);
    }
    entry.tf += 1;
    if (entry.pos.length < MAX_POSITIONS_PER_TERM) entry.pos.push(pos);
  }
  return byTerm;
}

// Bucket contents stay sorted by document id so reads can merge cheaply and
// a rewrite is always deterministic.
export function upsertDoc(docs, entry) {
  const out = docs.filter((d) => d.id !== entry.id);
  out.push(entry);
  out.sort((a, b) => a.id - b.id);
  return out;
}

export function removeDoc(docs, docId) {
  return docs.filter((d) => d.id !== docId);
}
