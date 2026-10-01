import { MSG } from '../../shared/messages.js';
import { t, rich, translatePage } from '../../shared/i18n.js';
import { PRESET_LABELS } from '../../shared/presets.js';
import { requestPersistence } from '../../shared/persistence.js';
import { MB, GB, syncCustom, limitValue, pagesFor } from '../shared/limits.js';
import { createLanguagePicker } from '../shared/language-picker.js';
import { defaultStemLanguages } from '../../core/stemming.js';

translatePage();

// The one moment everybody passes through, and the only context that is
// allowed to ask. See shared/persistence.js.
requestPersistence();

const ask = (type, payload) => chrome.runtime.sendMessage({ type, payload });
const byId = (id) => document.getElementById(id);
const sections = [...document.querySelectorAll('section[data-step]')];
const dots = [...document.querySelectorAll('.dots li')];

let step = 0;
let mode = 'broad';
const presetState = {};
// The screens actually visited, so Back retraces the path taken. Strict
// mode skips the exclusions screen, and Back from the one after it should
// not land on a screen that was never shown.
const trail = [];

function show(next, { back = false } = {}) {
  if (!back && next !== step) trail.push(step);
  step = Math.max(0, Math.min(sections.length - 1, next));
  sections.forEach((section, index) => {
    section.hidden = index !== step;
  });
  dots.forEach((dot, index) => dot.classList.toggle('on', index <= Math.min(step, dots.length - 1)));
  window.scrollTo({ top: 0 });
}

document.addEventListener('click', (event) => {
  if (event.target.matches('[data-next]')) show(step + 1);
  if (event.target.matches('[data-back]')) show(trail.length ? trail.pop() : step - 1, { back: true });
});

// Step two. The permission request has to be the first thing the click
// handler does: anything awaited before it spends the user gesture and
// Chrome refuses the request.
byId('chooseMode').addEventListener('click', (event) => {
  mode = document.querySelector('input[name="mode"]:checked').value;
  const note = byId('permissionNote');

  if (mode !== 'broad') {
    note.hidden = true;
    // Somebody who chose broad, granted it, and came Back for strict would
    // otherwise finish setup in strict mode still holding access to every
    // site, which is exactly what strict mode promises it does not hold.
    // Handing a permission back needs no user gesture, so this can wait.
    chrome.permissions.remove({ origins: ['*://*/*'] }).catch(() => false);
    // Strict mode skips the exclusions screen: nothing is read unless it is
    // added deliberately, so a list of things not to read has nothing to do.
    show(3);
    return;
  }

  chrome.permissions.request({ origins: ['*://*/*'] }).then((granted) => {
    if (granted) {
      note.hidden = true;
      show(2);
      return;
    }
    note.hidden = false;
    note.textContent = t('setup_permission_denied');
  });
});

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Step three, built from the shipped bundles.
const presets = byId('presets');
presets.innerHTML = Object.entries(PRESET_LABELS)
  .map(
    ([key, label]) =>
      '<label><input type="checkbox" data-preset="' + key + '" checked />' +
      '<span>' + escapeHtml(label.title) + '</span><span class="desc">' + escapeHtml(label.example) + '</span></label>'
  )
  .join('');
for (const key of Object.keys(PRESET_LABELS)) presetState[key] = true;
presets.addEventListener('change', (event) => {
  const key = event.target.dataset.preset;
  if (key) presetState[key] = event.target.checked;
});

// Step four. A cap in megabytes means nothing; a cap in pages does. The
// presets cover what most people want, and the custom field is there because
// this is their disk and a number somebody else picked is not a budget.
const sizeSelect = byId('size');
const sizeCustom = byId('sizeCustom');
const monthsSelect = byId('months');
const monthsCustom = byId('monthsCustom');

function capBytes() {
  const value = limitValue(sizeSelect, sizeCustom);
  if (value === null) return null;
  return sizeSelect.value === 'custom' ? Math.round(value * GB) : Math.round(value * MB);
}

function describeCapacity() {
  syncCustom(sizeSelect, sizeCustom);
  syncCustom(monthsSelect, monthsCustom);
  const bytes = capBytes();
  byId('capacity').textContent = bytes === null
    ? t('limit_type_number')
    : t('limit_capacity', pagesFor(bytes));
}
for (const control of [sizeSelect, sizeCustom, monthsSelect, monthsCustom]) {
  control.addEventListener('input', describeCapacity);
  control.addEventListener('change', describeCapacity);
}
describeCapacity();

// Step five. Pre-checked from what the browser says its person reads, so
// somebody who just clicks through ends up with a cheap, sane default rather
// than nothing or everything.
const languages = createLanguagePicker(byId('languages'), {
  selected: defaultStemLanguages(navigator.languages),
});

// The address bar keyword, from the manifest rather than retyped here, and the
// shortcut as Chrome actually has it: another extension may already own
// Ctrl+Shift+F, in which case Chrome leaves this one unset.
const manifest = chrome.runtime.getManifest();
const keyword = (manifest.omnibox && manifest.omnibox.keyword) || 'tm';
const hint = byId('doneHint');
rich(hint, 'setup_done_hint', keyword);
chrome.commands.getAll().then((commands) => {
  const command = commands.find((entry) => entry.name === 'open-search');
  if (!command || !command.shortcut) return;
  const keys = command.shortcut.split('+').map((key) => '<kbd>' + key.replace(/[<>&]/g, '') + '</kbd>').join(' ');
  rich(hint, 'setup_done_hint_shortcut', keys, keyword);
}).catch(() => {});

byId('finish').addEventListener('click', async () => {
  // A custom field left empty or nonsense falls back to the recommended
  // default rather than to zero, which would mean "keep nothing".
  const months = limitValue(monthsSelect, monthsCustom) || 12;
  await ask(MSG.SETTINGS_SET, {
    setupComplete: true,
    mode,
    presets: presetState,
    retentionMonths: months,
    sizeCapBytes: capBytes() || 500 * MB,
    stemLanguages: languages.value,
  });

  byId('doneNote').textContent = t(mode === 'broad' ? 'setup_done_broad' : 'setup_done_strict');
  show(5);
});

byId('close').addEventListener('click', () => window.close());
