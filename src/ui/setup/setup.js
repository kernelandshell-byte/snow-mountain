import { MSG } from '../../shared/messages.js';
import { PRESET_LABELS } from '../../shared/presets.js';
import { BYTES_PER_PAGE_ESTIMATE } from '../../shared/constants.js';

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

// Step four. A cap in megabytes means nothing; a cap in pages does.
function describeCapacity() {
  const mb = Number(byId('size').value);
  const pages = Math.round((mb * 1048576) / BYTES_PER_PAGE_ESTIMATE / 1000) * 1000;
  byId('capacity').textContent =
    'Roughly ' + pages.toLocaleString() + ' pages, measured on real articles. ' +
    'Once there are a few weeks of history the extension can tell you the date instead.';
}
byId('size').addEventListener('change', describeCapacity);
describeCapacity();

byId('finish').addEventListener('click', async () => {
  const months = Number(byId('months').value);
  await ask(MSG.SETTINGS_SET, {
    setupComplete: true,
    mode,
    presets: presetState,
    retentionMonths: months,
    sizeCapBytes: Number(byId('size').value) * 1048576,
  });

  byId('doneNote').textContent =
    mode === 'broad'
      ? 'Pages you read from now on are being indexed on this computer. Nothing that existed before today is in there, because nothing was watching yet.'
      : 'Nothing is being captured yet. Open a site you want kept and add it from the extension button.';
  show(4);
});

byId('close').addEventListener('click', () => window.close());
