// The toolbar badge, decided in one place.
//
// It is raised for the two states that mean pages are not being kept and
// that somebody can act on: the size cap cannot be met (more is pinned than
// fits), or the disk ran out. A pause is shown too, more quietly, because a
// pause that is forgotten looks exactly like an extension that stopped
// working. An archive resting at its cap is doing what it was told and gets
// nothing. Chrome clears the badge on restart, so this runs at startup as
// well as whenever one of its inputs changes.

import { DISPLAY_NAME } from '../shared/constants.js';
import { loadSettings, loadSweepState, isPaused } from '../shared/settings.js';

export const UNPAUSE_ALARM = 'unpause';
const WARN = '#b45309';
const QUIET = '#6b7280';

export async function refreshBadge() {
  const [settings, sweepState, local] = await Promise.all([
    loadSettings(),
    loadSweepState(),
    chrome.storage.local.get('storageFull').catch(() => ({})),
  ]);
  let text = '';
  let color = WARN;
  let title = DISPLAY_NAME;
  if (local && local.storageFull) {
    text = '!';
    title = DISPLAY_NAME + ': the disk is full, so pages are not being kept';
  } else if (sweepState.capUnmeetable) {
    text = '!';
    title = DISPLAY_NAME + ': more is pinned than the size limit allows';
  } else if (isPaused(settings)) {
    text = 'off';
    color = QUIET;
    title = DISPLAY_NAME + ': paused until ' + new Date(settings.pausedUntil).toLocaleTimeString();
  }
  await chrome.action.setBadgeText({ text }).catch(() => {});
  if (text) await chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  await chrome.action.setTitle({ title }).catch(() => {});

  // A pause ends by itself, and the badge has to notice.
  if (isPaused(settings)) {
    chrome.alarms.create(UNPAUSE_ALARM, { when: settings.pausedUntil + 1000 });
  } else {
    await chrome.alarms.clear(UNPAUSE_ALARM).catch(() => {});
  }
}
