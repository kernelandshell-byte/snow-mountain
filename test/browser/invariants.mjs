// The checks that must hold no matter what happened. Written as a function
// to be evaluated inside an extension page, so both the consistency suite
// and the resilience suite hold the store to exactly the same standard.

export async function invariantCheck(dbName) {
  const { openDatabase } = await import('/src/db/idb-store.js');
  const { tokenize } = await import('/src/core/tokenizer.js');
  const { bucketOf } = await import('/src/core/index-writer.js');

  const db = await openDatabase(dbName ? { name: dbName } : {});
  const readAll = (storeName) =>
    new Promise((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  const pages = await readAll('pages');
  const postings = await readAll('postings');
  const stats = (await readAll('meta')).find((row) => row.key === 'stats');
  const problems = [];

  if (!stats) problems.push('the statistics row is missing entirely');
  if (stats && stats.docCount !== pages.length) {
    problems.push('docCount says ' + stats.docCount + ' but there are ' + pages.length + ' pages');
  }
  const realBytes = pages.reduce((sum, p) => sum + (p.bytes || 0), 0);
  if (stats && stats.totalBytes !== realBytes) {
    problems.push('totalBytes says ' + stats.totalBytes + ' but the pages add up to ' + realBytes);
  }
  const realTokens = pages.reduce((sum, p) => sum + (p.wordCount || 0), 0);
  if (stats && stats.totalTokens !== realTokens) {
    problems.push('totalTokens says ' + stats.totalTokens + ' but the pages add up to ' + realTokens);
  }

  const liveIds = new Set(pages.map((p) => p.id));
  const indexed = new Map();
  let orphanEntries = 0;
  let emptyRecords = 0;
  for (const record of postings) {
    if (!record.docs.length) emptyRecords += 1;
    for (const entry of record.docs) {
      if (!liveIds.has(entry.id)) {
        orphanEntries += 1;
        continue;
      }
      if (!indexed.has(entry.id)) indexed.set(entry.id, new Set());
      indexed.get(entry.id).add(record.term);
      if (bucketOf(entry.id) !== record.bucket) {
        problems.push('page ' + entry.id + ' is filed in bucket ' + record.bucket);
      }
    }
  }
  if (orphanEntries) problems.push(orphanEntries + ' postings point at pages that no longer exist');
  if (emptyRecords) problems.push(emptyRecords + ' posting records are empty and should have been removed');

  let missingTerms = 0;
  let extraTerms = 0;
  for (const record of pages) {
    const expected = new Set(tokenize((record.title || '') + '\n\n' + (record.text || '')).map((t) => t.term));
    const actual = indexed.get(record.id) || new Set();
    for (const term of expected) if (!actual.has(term)) missingTerms += 1;
    for (const term of actual) if (!expected.has(term)) extraTerms += 1;
  }
  if (missingTerms) problems.push(missingTerms + ' words of live pages are missing from the index');
  if (extraTerms) problems.push(extraTerms + ' words are indexed for pages that no longer contain them');

  db.close();
  return { pages: pages.length, postingRecords: postings.length, problems };
}
