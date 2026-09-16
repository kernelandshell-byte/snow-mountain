import { MSG } from '../../shared/messages.js';
import { DISPLAY_NAME } from '../../shared/constants.js';
import { PRESET_LABELS } from '../../shared/presets.js';
import { requestPersistence } from '../../shared/persistence.js';
import { MB, GB, syncCustom, limitValue, pagesFor } from '../shared/limits.js';

document.title = 'Set up ' + DISPLAY_NAME;

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

function show(next) {
  step = Math.max(0, Math.min(sections.length - 1, next));
  sections.forEach((section, index) => {
    section.hidden = index !== step;
  });
  dots.forEach((dot, index) => dot.classList.toggle('on', index <= Math.min(step, dots.length - 1)));
  window.scrollTo({ top: 0 });
}

document.addEventListener('click', (event) => {
  if (event.target.matches('[data-next]')) show(step + 1);
  if (event.target.matches('[data-back]')) show(step - 1);
});

// Step two. The permission request has to be the first thing the click
// handler does: anything awaited before it spends the user gesture and
// Chrome refuses the request.
byId('chooseMode').addEventListener('click', (event) => {
  mode = document.querySelector('input[name="mode"]:checked').value;
  const note = byId('permissionNote');

  if (mode !== 'broad') {
    note.hidden = true;
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
    note.textContent =
      'Chrome did not grant access to all sites, so nothing would be captured. ' +
      'Either try again, or choose the second option and add sites one at a time.';
  });
});

// Step three, built from the shipped bundles.
const presets = byId('presets');
presets.innerHTML = Object.entries(PRESET_LABELS)
  .map(
    ([key, label]) =>
      '<label><input type="checkbox" data-preset="' + key + '" checked />' +
      '<span>' + label.title + '</span><span class="desc">' + label.example + '</span></label>'
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
    ? 'Type a number and this will say what it holds.'
    : 'Roughly ' + pagesFor(bytes) + ' pages, measured on real articles. ' +
      'Once there are a few weeks of history the extension can tell you the date instead.';
}
for (const control of [sizeSelect, sizeCustom, monthsSelect, monthsCustom]) {
  control.addEventListener('input', describeCapacity);
  control.addEventListener('change', describeCapacity);
}
describeCapacity();

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
  });

  byId('doneNote').textContent =
    mode === 'broad'
      ? 'Pages you read from now on are being indexed on this computer. Nothing that existed before today is in there, because nothing was watching yet.'
      : 'Nothing is being captured yet. Open a site you want kept and add it from the extension button.';
  show(4);
});

byId('close').addEventListener('click', () => window.close());
