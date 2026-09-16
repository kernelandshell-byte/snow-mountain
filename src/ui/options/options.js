import { MSG } from '../../shared/messages.js';
import { PRESET_LABELS } from '../../shared/presets.js';
import {
  BYTES_PER_PAGE_ESTIMATE, DISPLAY_NAME, SLUG, EXPORT_FORMATS_ACCEPTED,
} from '../../shared/constants.js';
import { bytes as mb, pageCount } from '../../shared/format.js';
import { requestPersistence } from '../../shared/persistence.js';
import { MB, GB, showLimit, syncCustom, limitValue, pagesFor, describeSize } from '../shared/limits.js';

const ask = (type, payload) => chrome.runtime.sendMessage({ type, payload });
const byId = (id) => document.getElementById(id);

// Read from the one constant rather than written into the markup, so the name
// really does live in a single place. See the naming section of BRIEF.md.
document.title = DISPLAY_NAME + ' settings';

// Asking here as well as during setup, because persistence can be refused the
// first time and granted later, and because somebody opening settings is
// somebody who would want to know if it had been refused.
await requestPersistence();

let settings = await ask(MSG.SETTINGS_GET);
let saveTimer;

function flashSaved() {
  const badge = byId('saved');
  badge.hidden = false;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { badge.hidden = true; }, 1400);
}

async function save(patch) {
  settings = await ask(MSG.SETTINGS_SET, patch);
  flashSaved();
}

// The mode switch, and the part of it that makes strict mode mean anything.
//
// Every competitor's privacy mode is a promise. This one is meant to be
// enforced by the browser, and it only is if switching away from broad mode
// actually hands the wide permission back. Leaving it granted and merely
// unregistering the content scripts would look identical in here and be a lie
// on Chrome's own permissions screen.
const WIDE = ['*://*/*'];
const originsFor = (domain) => ['*://' + domain + '/*', '*://*.' + domain + '/*'];

function renderMode() {
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.checked = radio.value === settings.mode;
  }
  byId('modeLine').textContent =
    settings.mode === 'broad'
      ? 'Every site is read except what you exclude below.'
      : 'Only sites you have added are read. Chrome enforces that, not this extension.';
  byId('presetBlock').hidden = settings.mode !== 'broad';
  byId('allowBlock').hidden = settings.mode !== 'strict';
  if (settings.mode === 'strict') renderAllowlist();
}

function renderAllowlist() {
  const list = byId('allowlist');
  list.innerHTML = '';
  if (!settings.allowlist.length) {
    const empty = document.createElement('li');
    empty.className = 'when';
    empty.textContent = 'None yet. Open a site you want kept and add it from the extension button.';
    list.appendChild(empty);
    return;
  }
  for (const domain of settings.allowlist) {
    const row = document.createElement('li');
    row.className = 'site';
    const name = document.createElement('span');
    name.textContent = domain;
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = 'remove';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      // Taking the permission back first. If Chrome refuses, the site stays on
      // the list rather than the list claiming something Chrome disagrees with.
      await chrome.permissions.remove({ origins: originsFor(domain) }).catch(() => false);
      await save({ allowlist: settings.allowlist.filter((entry) => entry !== domain) });
      renderAllowlist();
    });
    row.append(name, remove);
    list.appendChild(row);
  }
}

document.querySelector('.modes').addEventListener('change', (event) => {
  const next = event.target.value;
  if (!next || next === settings.mode) return;

  if (next === 'broad') {
    // First statement in the handler: awaiting anything before a permission
    // request spends the user gesture and Chrome refuses it.
    chrome.permissions.request({ origins: WIDE }).then(async (granted) => {
      if (!granted) {
        // renderMode first, because it rewrites this line from the setting.
        renderMode();
        byId('modeLine').textContent =
          'Chrome did not grant access to all sites, so nothing changed. Still only reading sites you add.';
        return;
      }
      await save({ mode: 'broad' });
      renderMode();
    });
    return;
  }

  // Broad to strict. The permission actually goes; that is the whole point.
  chrome.permissions.remove({ origins: WIDE }).then(async () => {
    await save({ mode: 'strict' });
    renderMode();
  });
});

renderMode();

byId('presets').innerHTML = Object.entries(PRESET_LABELS)
  .map(
    ([key, label]) =>
      '<label><input type="checkbox" data-preset="' + key + '"' +
      (settings.presets[key] ? ' checked' : '') + ' />' +
      '<span>' + label.title + '</span><span class="desc">' + label.example + '</span></label>'
  )
  .join('');

byId('presets').addEventListener('change', (event) => {
  const key = event.target.dataset.preset;
  if (!key) return;
  save({ presets: { ...settings.presets, [key]: event.target.checked } });
});

const rules = byId('rules');
rules.value = (settings.customRules || []).join('\n');
let rulesTimer;
rules.addEventListener('input', () => {
  clearTimeout(rulesTimer);
  // Saving on every keystroke would re-register content scripts constantly,
  // so this waits for a pause instead.
  rulesTimer = setTimeout(() => {
    save({
      customRules: rules.value.split('\n').map((line) => line.trim()).filter(Boolean),
    });
  }, 700);
});

// The budget controls. Presets for the people who want one, a custom field
// for the people who do not, and no ceiling on either: it is their disk.
const months = byId('months');
const monthsCustom = byId('monthsCustom');
const size = byId('size');
const sizeCustom = byId('sizeCustom');

// Presets are megabytes, the custom field is gigabytes, because nobody wants
// to type fifty one thousand two hundred.
const capBytes = () => {
  const value = limitValue(size, sizeCustom);
  if (value === null) return null;
  return size.value === 'custom' ? Math.round(value * GB) : Math.round(value * MB);
};

showLimit(months, monthsCustom, settings.retentionMonths);
showLimit(size, sizeCustom, Math.round(settings.sizeCapBytes / MB));
// A custom size was stored in bytes, so showLimit put megabytes in the field.
if (size.value === 'custom') sizeCustom.value = String(+(settings.sizeCapBytes / GB).toFixed(3));

// Said before it is saved, not after, because this is the one setting whose
// consequence cannot be undone. Lowering the cap does not delete anything by
// itself, but the next sweep will, and being told afterwards is not being told.
let usedBytes = null;
function describeLimits() {
  const bytes = capBytes();
  const note = byId('capacityNote');
  const shrink = byId('shrinkNote');
  if (bytes === null) {
    note.textContent = 'Type a number and this will say what it holds.';
    shrink.hidden = true;
    return;
  }
  note.textContent = 'Room for roughly ' + pagesFor(bytes) + ' pages, at the size real articles come out at.';
  const over = usedBytes !== null && usedBytes > bytes;
  shrink.hidden = !over;
  if (over) {
    const losing = Math.max(1, Math.round((usedBytes - bytes) / BYTES_PER_PAGE_ESTIMATE));
    shrink.textContent =
      'You are keeping ' + mb(usedBytes) + ' now, which is more than ' + describeSize(bytes) +
      '. The next sweep would remove roughly ' + losing.toLocaleString() +
      ' of your oldest unpinned pages. Pinned pages are never removed.';
  }
}

for (const control of [months, monthsCustom, size, sizeCustom]) {
  control.addEventListener('input', () => {
    syncCustom(months, monthsCustom);
    syncCustom(size, sizeCustom);
    describeLimits();
  });
}

months.addEventListener('change', () => {
  const value = limitValue(months, monthsCustom);
  if (value !== null) save({ retentionMonths: value });
});
monthsCustom.addEventListener('change', () => {
  const value = limitValue(months, monthsCustom);
  if (value !== null) save({ retentionMonths: value });
});
const saveSize = () => {
  const bytes = capBytes();
  if (bytes !== null) save({ sizeCapBytes: bytes }).then(refreshUsage);
};
size.addEventListener('change', saveSize);
sizeCustom.addEventListener('change', saveSize);
describeLimits();

// An archive that cannot be opened is not an empty one. Going quiet here, or
// showing a zeroed meter, tells somebody their year of reading is gone when it
// is sitting on disk untouched.
function reportUnavailable(stats) {
  byId('fill').style.width = '0%';
  byId('usage').textContent =
    'The archive could not be opened, so nothing here can be shown. ' +
    'Nothing has been deleted.' + (stats && stats.detail ? ' (' + stats.detail + ')' : '');
  byId('log').innerHTML = '<li class="when">Not available while the archive cannot be opened.</li>';
  for (const id of ['sweep', 'export', 'wipe', 'import']) {
    const button = byId(id);
    if (button) button.disabled = true;
  }
}

async function refreshUsage() {
  const stats = await ask(MSG.STATS).catch(() => null);
  if (!stats || stats.error || stats.ready === false) return reportUnavailable(stats);
  const fraction = Math.min(1, stats.budget.fraction);
  const fill = byId('fill');
  fill.style.width = Math.max(1, fraction * 100) + '%';
  fill.classList.toggle('warn', stats.budget.level !== 'ok');

  usedBytes = stats.usedBytes;
  describeLimits();
  const capacity = Math.round(stats.budget.sizeCapBytes / BYTES_PER_PAGE_ESTIMATE / 1000) * 1000;
  const parts = [
    pageCount(stats.docCount) + ', ' + mb(stats.usedBytes) + ' of ' + mb(stats.budget.sizeCapBytes),
    'room for roughly ' + capacity.toLocaleString(),
  ];
  if (stats.capUnmeetable) {
    parts.push('more is pinned than the budget allows');
  } else if (stats.atCap) {
    parts.push('full, oldest pages being replaced');
  } else if (stats.exhaustsAt) {
    parts.push('full around ' + new Date(stats.exhaustsAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
  }
  byId('usage').textContent = parts.join(' · ');

  // Point six of the migration policy, and the only place it is said. An
  // upgrade that moved somebody's archive is worth one sentence and then never
  // again, which is why acknowledging it clears the record.
  const migrationNote = byId('migrationNote');
  if (migrationNote && stats.lastMigration) {
    const steps = (stats.lastMigration.steps || []).join(', ');
    migrationNote.hidden = false;
    migrationNote.textContent =
      'The archive was upgraded on ' + new Date(stats.lastMigration.at).toLocaleDateString() +
      (steps ? ' to ' + steps : '') + '. Everything was checked across and nothing was lost.';
    ask(MSG.ACKNOWLEDGE, { what: 'lastMigration' });
  }

  const warnings = [];
  if (stats.storageFull) {
    warnings.push(
      'This disk ran out of room on ' + new Date(stats.storageFull).toLocaleDateString() +
      ', so pages were not kept. Freeing space, or lowering the size limit above, fixes it.'
    );
  }
  if (stats.persisted === false) {
    warnings.push(
      'Chrome has not granted this archive persistent storage, which means it can be cleared ' +
      'without warning when the disk gets full. Exporting now and then is worth doing.'
    );
  }
  // Capture failing is the one failure that leaves no trace to notice later:
  // the pages simply are not there, and an empty result looks like a page you
  // never read rather than one that was never kept.
  const watch = stats.captureWatch;
  if (watch && watch.mode === 'strict') {
    if (watch.ungranted && watch.ungranted.length) {
      warnings.push(
        'These sites are on your list but Chrome has not granted access to them, so nothing is ' +
        'being kept from them: ' + watch.ungranted.join(', ') + '. Removing and adding them again ' +
        'asks for access properly.'
      );
    }
    if (watch.refused && watch.refused.length) {
      warnings.push(
        'Chrome refused to watch ' + watch.refused.join(', ') + ', so nothing is being kept from ' +
        'them. The other sites on your list are unaffected.'
      );
    }
  }

  const storageNote = byId('storageNote');
  if (storageNote) {
    storageNote.hidden = warnings.length === 0;
    storageNote.textContent = warnings.join(' ');
  }

  const clock = byId('clockNote');
  if (clock) {
    // Saying nothing would leave an unexplained gap in the storage log.
    clock.hidden = !stats.clockProblem;
    clock.textContent = stats.clockProblem
      ? 'The last sweep left the age limit alone because ' + stats.clockProblem +
        '. Nothing was removed by age. It will apply again at the next sweep.'
      : '';
  }
}

async function refreshLog() {
  const entries = (await ask(MSG.LOG, { limit: 15 }).catch(() => [])) || [];
  if (!Array.isArray(entries)) return;
  byId('log').innerHTML = entries.length
    ? entries
        .map(
          (entry) =>
            '<li>' + entry.count + ' pages, ' + mb(entry.bytesFreed || 0) +
            ' <span class="when">' + ({
              age: 'older than your limit',
              size: 'over your size limit',
              manual: 'deleted by you',
              siteRule: 'excluded site',
            }[entry.reason] || entry.reason) + ', ' +
            new Date(entry.at).toLocaleDateString() + '</span></li>'
        )
        .join('')
    : '<li class="when">Nothing has been removed.</li>';
}

byId('sweep').addEventListener('click', async () => {
  const result = await ask(MSG.MAINTENANCE);
  byId('dataNote').textContent =
    result.evicted ? 'Removed ' + result.evicted + ' pages.' : 'Nothing needed removing.';
  await refreshUsage();
  await refreshLog();
});

// Export walks the archive rather than asking for it in one piece, because a
// full archive is hundreds of megabytes and neither a single message nor a
// single JSON string will carry that. The chunks go into the Blob as separate
// strings for the same reason.
const EXPORT_BATCH = 200;

byId('export').addEventListener('click', async () => {
  const note = byId('dataNote');
  const progress = byId('progress');
  const fill = byId('progressFill');
  progress.hidden = false;

  const chunks = [];
  let written = 0;
  let afterId = 0;
  let header = null;

  for (let guard = 0; guard < 100000; guard++) {
    const slice = await ask(MSG.EXPORT, { afterId, limit: EXPORT_BATCH });
    if (!slice || slice.error) {
      progress.hidden = true;
      note.textContent = 'The archive could not be read, so nothing was exported.';
      return;
    }
    if (!header) {
      header = slice;
      chunks.push(
        '{\n  "format": ' + JSON.stringify(slice.format) +
        ',\n  "version": ' + JSON.stringify(slice.version) +
        ',\n  "exportedAt": ' + JSON.stringify(slice.exportedAt) +
        ',\n  "settings": ' + JSON.stringify(slice.settings) +
        ',\n  "pages": [\n'
      );
    }
    for (const page of slice.pages) {
      chunks.push((written ? ',\n' : '') + '    ' + JSON.stringify(page));
      written += 1;
    }
    if (header.total) {
      fill.style.width = Math.min(100, Math.round((written / header.total) * 100)) + '%';
      note.textContent = 'Exporting… ' + written + ' of ' + header.total;
    }
    if (slice.done || slice.lastId === null) break;
    afterId = slice.lastId;
  }
  chunks.push('\n  ]\n}\n');

  const blob = new Blob(chunks, { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = SLUG + '-' + new Date().toISOString().slice(0, 10) + '.json';
  link.click();
  URL.revokeObjectURL(url);

  progress.hidden = true;
  fill.style.width = '0%';
  note.textContent = 'Exported ' + written + ' pages.';
});

// Imported in batches so a large archive shows progress rather than
// freezing, and so no single message has to survive the whole job.
const IMPORT_BATCH = 25;

byId('import').addEventListener('click', () => byId('importFile').click());

byId('importFile').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const note = byId('dataNote');

  let archive;
  try {
    archive = JSON.parse(await file.text());
  } catch {
    note.textContent = 'That file is not valid JSON.';
    return;
  }
  // Exports written under the old format identifier still import, because
  // somebody's file on disk is not something to break over a rename.
  if (!EXPORT_FORMATS_ACCEPTED.includes(archive.format) || !Array.isArray(archive.pages)) {
    note.textContent = 'That does not look like an export from this extension.';
    return;
  }

  const progress = byId('progress');
  const fill = byId('progressFill');
  progress.hidden = false;

  const totals = { imported: 0, skipped: 0, failed: 0 };
  for (let start = 0; start < archive.pages.length; start += IMPORT_BATCH) {
    const batch = archive.pages.slice(start, start + IMPORT_BATCH);
    const result = await ask(MSG.IMPORT, { pages: batch });
    totals.imported += result.imported;
    totals.skipped += result.skipped;
    totals.failed += result.failed;
    fill.style.width = Math.round(((start + batch.length) / archive.pages.length) * 100) + '%';
    note.textContent = 'Importing… ' + (start + batch.length) + ' of ' + archive.pages.length;
  }

  progress.hidden = true;
  fill.style.width = '0%';
  const parts = [totals.imported + ' imported'];
  if (totals.skipped) parts.push(totals.skipped + ' already here');
  if (totals.failed) parts.push(totals.failed + ' could not be read');
  note.textContent = parts.join(', ');
  event.target.value = '';
  await refreshUsage();
});

byId('wipe').addEventListener('click', async () => {
  // Two clicks, no dialog. A confirm() in an extension page is easy to
  // dismiss by accident and this is the one irreversible button here.
  const button = byId('wipe');
  if (button.dataset.armed !== 'yes') {
    button.dataset.armed = 'yes';
    button.textContent = 'Click again to delete everything';
    setTimeout(() => {
      button.dataset.armed = '';
      button.textContent = 'Delete everything';
    }, 4000);
    return;
  }
  const result = await ask(MSG.WIPE);
  button.dataset.armed = '';
  button.textContent = 'Delete everything';
  byId('dataNote').textContent = 'Deleted ' + result.deleted + ' pages.';
  await refreshUsage();
  await refreshLog();
});

await refreshUsage();
await refreshLog();
