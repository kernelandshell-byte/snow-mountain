import { MSG } from '../../shared/messages.js';
import { PRESET_LABELS } from '../../shared/presets.js';
import { BYTES_PER_PAGE_ESTIMATE } from '../../shared/constants.js';
import { bytes as mb, pageCount } from '../../shared/format.js';

const ask = (type, payload) => chrome.runtime.sendMessage({ type, payload });
const byId = (id) => document.getElementById(id);

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

byId('modeLine').textContent =
  settings.mode === 'broad'
    ? 'Every site is read except what you exclude below.'
    : 'Only sites you have added are read. Chrome enforces that, not this extension.';

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

byId('months').value = String(settings.retentionMonths);
byId('size').value = String(Math.round(settings.sizeCapBytes / 1048576));
byId('months').addEventListener('change', (event) => save({ retentionMonths: Number(event.target.value) }));
byId('size').addEventListener('change', (event) => {
  save({ sizeCapBytes: Number(event.target.value) * 1048576 }).then(refreshUsage);
});

async function refreshUsage() {
  const stats = await ask(MSG.STATS);
  if (!stats || stats.error) return;
  const fraction = Math.min(1, stats.budget.fraction);
  const fill = byId('fill');
  fill.style.width = Math.max(1, fraction * 100) + '%';
  fill.classList.toggle('warn', stats.budget.level !== 'ok');

  const capacity = Math.round(stats.budget.sizeCapBytes / BYTES_PER_PAGE_ESTIMATE / 1000) * 1000;
  const parts = [
    pageCount(stats.docCount) + ', ' + mb(stats.usedBytes) + ' of ' + mb(stats.budget.sizeCapBytes),
    'room for roughly ' + capacity.toLocaleString(),
  ];
  if (stats.exhaustsAt) {
    parts.push('full around ' + new Date(stats.exhaustsAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
  }
  byId('usage').textContent = parts.join(' · ');
}

async function refreshLog() {
  const entries = (await ask(MSG.LOG, { limit: 15 })) || [];
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

byId('export').addEventListener('click', async () => {
  const data = await ask(MSG.EXPORT);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'snow-mountain-' + new Date().toISOString().slice(0, 10) + '.json';
  link.click();
  URL.revokeObjectURL(url);
  byId('dataNote').textContent = 'Exported ' + data.pages.length + ' pages.';
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
  if (archive.format !== 'snow-mountain-export' || !Array.isArray(archive.pages)) {
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
