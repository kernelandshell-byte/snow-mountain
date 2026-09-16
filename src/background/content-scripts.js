// Where the extension is allowed to watch, and keeping Chrome's idea of that
// in step with the user's.
//
// Content scripts are registered at runtime rather than declared in the
// manifest, so installing this extension asks for no host access at all.

import { MODE } from '../core/capture-policy.js';
import { loadSettings } from '../shared/settings.js';

const CONTENT_SCRIPT_ID = 'observer';

export const matchFor = (host) => '*://*.' + String(host).replace(/^\*\./, '') + '/*';

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

// Which of the allowlisted sites Chrome will actually let us watch.
//
// The allowlist and the granted permissions are two separate records of the
// same intention, and they drift: a permission can be revoked from Chrome's
// own settings screen without this extension hearing about it in a form it
// can act on. Registering a match the extension has no permission for makes
// Chrome reject the call, and it rejects the whole call, not the bad entry --
// so one stale row used to stop capture on every other site in the list.
async function grantedMatches(hosts) {
  const checks = await Promise.all(
    hosts.map(async (host) => {
      const match = matchFor(host);
      const granted = await chrome.permissions.contains({ origins: [match] }).catch(() => false);
      return { host, match, granted };
    })
  );
  return {
    matches: checks.filter((c) => c.granted).map((c) => c.match),
    ungranted: checks.filter((c) => !c.granted).map((c) => c.host),
  };
}

async function doSyncContentScripts() {
  const settings = await loadSettings();
  const existing = await chrome.scripting
    .getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] })
    .catch(() => []);

  let matches = [];
  let ungranted = [];
  if (settings.mode === MODE.BROAD) {
    const granted = await chrome.permissions.contains({ origins: ['*://*/*'] }).catch(() => false);
    matches = granted ? ['http://*/*', 'https://*/*'] : [];
  } else {
    ({ matches, ungranted } = await grantedMatches(settings.allowlist));
  }

  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }).catch(() => {});
  }

  let problem = null;
  if (matches.length) {
    try {
      await register(matches);
    } catch (error) {
      // Registration can lose a race with an unregister that has not landed
      // yet, and the next settings change or startup registers it again. But
      // it can also fail for a reason that will still be true tomorrow, and
      // capture failing silently is capture failing at the one job this
      // extension has. So try the sites one at a time, keep the ones that
      // work, and record the ones that do not.
      const kept = [];
      const refused = [];
      for (const match of matches) {
        try {
          if (kept.length) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
          await register([...kept, match]);
          kept.push(match);
        } catch {
          refused.push(match);
        }
      }
      if (refused.length) problem = { refused, detail: String((error && error.message) || error) };
    }
  }

  // Settings reads this so it can say which sites are not being watched, and
  // why. Nothing else in this extension fails quietly, and this used to.
  await chrome.storage.local
    .set({
      contentScripts: {
        at: Date.now(),
        mode: settings.mode,
        watching: matches.length,
        ungranted,
        refused: (problem && problem.refused) || [],
        detail: (problem && problem.detail) || null,
      },
    })
    .catch(() => {});
}

function register(matches) {
  return chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      js: ['src/content/observer.js'],
      matches,
      runAt: 'document_idle',
      allFrames: false,
    },
  ]);
}
