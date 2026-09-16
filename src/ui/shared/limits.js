// The two budget controls, shared by setup and settings so they cannot drift.
//
// Both are a short list of sensible presets plus a way to say a number nobody
// thought to offer. The presets exist because most people want one of them and
// should not have to do arithmetic; the custom field exists because a limit
// somebody else chose for you, on your own disk, is not a limit, it is a
// judgement about how much reading you are allowed to keep.
//
// There is deliberately no ceiling. The manifest asks for unlimitedStorage,
// so Chrome is not the thing stopping anyone, and an archive is only ever as
// big as the disk it sits on.

import { BYTES_PER_PAGE_ESTIMATE } from '../../shared/constants.js';

export const MB = 1048576;
export const GB = 1024 * MB;

const CUSTOM = 'custom';

// Show a stored value on the control, whatever it is. A value that matches a
// preset selects it; anything else opens the custom field with the number
// already in it, which also means a custom limit survives being looked at.
export function showLimit(select, input, value) {
  const asPreset = [...select.options].some((option) => option.value === String(value));
  if (asPreset) {
    select.value = String(value);
    input.value = '';
  } else {
    select.value = CUSTOM;
    input.value = String(value);
  }
  syncCustom(select, input);
}

// Keep the custom field visible exactly when it is the thing being used.
export function syncCustom(select, input) {
  const field = input.closest('.field') || input.parentElement;
  const custom = select.value === CUSTOM;
  if (field) field.hidden = !custom;
  return custom;
}

// What the control currently means. Returns null rather than a guess when the
// custom field holds something that is not a number, because saving a guess
// here is how somebody's retention limit quietly becomes twelve months again.
export function limitValue(select, input) {
  if (select.value !== CUSTOM) return Number(select.value);
  const typed = Number(input.value);
  return Number.isFinite(typed) && typed > 0 ? typed : null;
}

// A cap in gigabytes means nothing. A cap in pages means something, which is
// why this is on the screen next to the number rather than in the help.
export function pagesFor(bytes) {
  const pages = bytes / BYTES_PER_PAGE_ESTIMATE;
  if (pages < 1000) return Math.max(1, Math.round(pages / 10) * 10).toLocaleString();
  if (pages < 100000) return (Math.round(pages / 1000) * 1000).toLocaleString();
  return (Math.round(pages / 100000) * 100000).toLocaleString();
}

export function describeSize(bytes) {
  if (bytes >= GB) return (bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1) + 'GB';
  return Math.round(bytes / MB) + 'MB';
}
