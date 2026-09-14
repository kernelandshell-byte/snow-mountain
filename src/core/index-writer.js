import { BUCKET_SHIFT, MAX_POSITIONS_PER_TERM } from '../shared/constants.js';
import { byteLength } from './hash.js';

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

// What a document costs the index.
//
// The storage budget is the promise this extension makes about its footprint,
// and it used to be enforced against the size of the stored text alone. The
// index is roughly three and a half times the text it indexes, so a 500MB
// budget was really a 2.4GB one: the meter counted about a fifth of what was
// on disk, and the settings screen's "room for roughly 34,000 pages"
// disagreed with its own meter by a factor of five. See test:storage.
//
// So a page's `bytes` includes what it added to the index, and these are the
// two shapes it adds. They are serialised sizes rather than guesses:
//
//   an entry in a posting list   {"id":12345,"tf":7,"pos":[1,2,3]}
//   the record that holds them   {"term":"x","bucket":9,"docs":[]}, plus the
//                                compound key IndexedDB stores alongside it
//
// The numbers are solved against a measured archive rather than counted off
// the shapes above, because IndexedDB stores structured clones and keys, not
// the JSON they resemble. At two thousand pages: 579,481 entries across 35,794
// records weighing 18.4MB, which is 30.2 bytes an entry once the records are
// paid for, against an average of 1.17 positions per entry.
//
// The record is charged once, to whichever document first mentions that term
// in that bucket, because that is the document whose write creates it. Up to
// 255 others then join it for the cost of an entry each, which is what
// actually happens on disk. Charging every document for the whole record
// instead overstated a 2,000 page archive by 88%.
export const postingEntryBytes = (positions) => 25 + positions * 4;
export const postingRecordBytes = (term) => 34 + byteLength(term) * 2;

// The estimate, for anything that has tokens but is not writing them: it
// assumes every term is new, which is right for the first pages in an archive
// and an overstatement afterwards. The stores do not use this; they count what
// they actually wrote.
export function indexBytesFor(tokens) {
  let bytes = 0;
  for (const [term, entry] of buildPostings(tokens)) {
    bytes += postingEntryBytes(entry.pos.length) + postingRecordBytes(term);
  }
  return bytes;
}
