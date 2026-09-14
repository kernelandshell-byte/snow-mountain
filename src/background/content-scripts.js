// Where the extension is allowed to watch, and keeping Chrome's idea of that
// in step with the user's.
//
// Content scripts are registered at runtime rather than declared in the
// manifest, so installing this extension asks for no host access at all.

import { MODE } from '../core/capture-policy.js';
import { loadSettings } from '../shared/settings.js';

const CONTENT_SCRIPT_ID = 'observer';

// Content scripts are registered at runtime rather than declared in the
// manifest, so install time asks for no host access at all. Broad mode gets
// the wide permission during setup, strict mode gets one origin at a time.
let syncing = null;
export function syncContentScripts() {
  // Serialised, because a settings save and a permission event can arrive
  // together and the second registration would fail on a duplicate id.
  syncing = (syncing || Promise.resolve()).then(doSyncContentScripts, doSyncContentScripts);
  return syncing;
}

async function doSyncContentScripts() {
  const settings = await loadSettings();
  const existing = await chrome.scripting
    .getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] })
    .catch(() => []);

  let matches = [];
  if (settings.mode === MODE.BROAD) {
    const granted = await chrome.permissions.contains({ origins: ['*://*/*'] });
    matches = granted ? ['http://*/*', 'https://*/*'] : [];
  } else {
    // Both schemes, to match the permission the popup actually requests.
    matches = settings.allowlist.map((host) => '*://*.' + host.replace(/^\*\./, '') + '/*');
  }

  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  }
  if (!matches.length) return;

  await chrome.scripting
    .registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        js: ['src/content/observer.js'],
        matches,
        runAt: 'document_idle',
        allFrames: false,
      },
    ])
    .catch(() => {
      // Registration can lose a race with an unregister that has not landed
      // yet. The next settings change or startup registers it again.
    });
}
