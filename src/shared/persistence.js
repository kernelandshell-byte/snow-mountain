// Asking Chrome not to throw the archive away.
//
// Storage that has not been marked persistent is "best effort", which means
// Chrome may clear it under disk pressure without telling anybody. For a tool
// whose whole purpose is remembering what you read, that is the worst possible
// failure, and it is silent.
//
// The awkward part: StorageManager.persist() is only exposed to windows, not
// to workers. A service worker can ask whether storage is persistent and can
// never make it so, which is why this is called from the extension's pages --
// setup, which everybody sees once, and settings, which is where the answer
// gets reported if it was refused.

export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persisted) return null;
    const already = await navigator.storage.persisted();
    const granted =
      already || (navigator.storage.persist ? await navigator.storage.persist() : false);
    await chrome.storage.local.set({ persistence: { granted, checkedAt: Date.now() } });
    return granted;
  } catch {
    // Never let this break a page. Not knowing is a worse answer than knowing,
    // but it is a much better one than a settings screen that will not load.
    return null;
  }
}

// What a worker can do: read the answer back, so a grant that was later
// revoked does not go on being reported as a grant.
export async function refreshPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persisted) return null;
    const granted = await navigator.storage.persisted();
    const stored = await chrome.storage.local.get('persistence');
    const before = stored.persistence ? stored.persistence.granted : null;
    if (before !== granted) {
      await chrome.storage.local.set({ persistence: { granted, checkedAt: Date.now() } });
    }
    return granted;
  } catch {
    return null;
  }
}
