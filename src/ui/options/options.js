import { MSG } from '../../shared/messages.js';
import { PRESET_LABELS } from '../../shared/presets.js';
import {
  BYTES_PER_PAGE_ESTIMATE, DISPLAY_NAME, SLUG, EXPORT_FORMATS_ACCEPTED,
} from '../../shared/constants.js';
import { bytes as mb, pageCount } from '../../shared/format.js';
import { requestPersistence } from '../../shared/persistence.js';
import { MB, GB, showLimit, syncCustom, limitValue, pagesFor, describeSize } from '../shared/limits.js';
import { createLanguagePicker } from '../shared/language-picker.js';
import { readExport } from '../shared/export-reader.js';
import { normaliseRule } from '../../core/capture-policy.js';

const ask = (type, payload) => chrome.runtime.sendMessage({ type, payload });
const byId = (id) => document.getElementById(id);

// Read from the one constant rather than written into the markup, so the name
// really does live in a single place.
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
      : "Only sites you've added are read, and Chrome enforces that. The exclusions below still apply to them.";
  byId('allowBlock').hidden = settings.mode !== 'strict';
  if (settings.mode === 'strict') renderAllowlist();
}

function renderAllowlist() {
  const list = byId('allowlist');
  list.innerHTML = '';
  if (!settings.allowlist.length) {
    const empty = document.createElement('li');
    empty.className = 'when';
    empty.textContent = 'None yet. Open a site you want to keep and add it from the extension button.';
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
      // Taking the permission back first. The site comes off the list either
      // way: a site whose access was already revoked in Chrome's own settings
      // has nothing to hand back, and has to be removable all the same.
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

  // Broad to strict. The permission actually goes; that is the whole point,
  // so if Chrome will not take it back, nothing changes and the page says so
  // rather than claiming a mode Chrome does not agree with.
  chrome.permissions.remove({ origins: WIDE }).then(async (removed) => {
    if (!removed) throw new Error('not removed');
    await save({ mode: 'strict' });
    renderMode();
  }).catch(() => {
    renderMode();
    byId('modeLine').textContent =
      "Chrome didn't remove the extension's access to all sites, so nothing changed. Try again, " +
      'or remove it from the extension\'s details page in chrome://extensions.';
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

// A category is a list somebody else maintains, so ticking it removes what
// it covers straight away, as "stop saving this site" does in the popup.
byId('presets').addEventListener('change', async (event) => {
  const key = event.target.dataset.preset;
  if (!key) return;
  const note = byId('presetNote');
  note.hidden = true;
  // Only the category that changed. Sending every category from this page's
  // copy let two quick ticks overwrite each other with a stale value.
  await save({ presets: { [key]: event.target.checked } });
  if (!event.target.checked) return;
  const result = await ask(MSG.REMOVE_EXCLUDED, { scope: 'preset', name: key }).catch(() => null);
  if (!result || result.error) {
    note.textContent = 'Pages already saved from these sites could not be removed. Untick and tick it again to retry.';
    note.hidden = false;
    return;
  }
  if (!result.removed) return;
  note.textContent = 'Removed ' + pageCount(result.removed) + ' already saved from ' +
    PRESET_LABELS[key].title.toLowerCase() + '.';
  note.hidden = false;
  await refreshUsage();
  await refreshLog();
});

// Categories this version added. They apply to what is read from now on;
// what they would remove from before is asked about rather than taken,
// because nobody chose them. Either answer is final, including through later
// updates. See noteNewCategories in background/archive.js.
async function offerNewCategories() {
  const stats = await ask(MSG.STATS).catch(() => null);
  const keys = (stats && Array.isArray(stats.newCategories) ? stats.newCategories : [])
    .filter((key) => PRESET_LABELS[key]);
  const box = byId('newCategories');
  if (!keys.length || stats.ready === false) {
    box.hidden = true;
    return;
  }
  let matched = 0;
  for (const name of keys) {
    const result = await ask(MSG.REMOVE_EXCLUDED, { scope: 'preset', name, dryRun: true }).catch(() => null);
    matched += (result && result.matched) || 0;
  }
  const names = keys.map((key) => PRESET_LABELS[key].title).join(' and ');
  if (!matched) {
    // Nothing from before to ask about: settle it quietly.
    for (const name of keys) await ask(MSG.REMOVE_EXCLUDED, { scope: 'preset', name, keepExisting: true });
    box.hidden = true;
    return;
  }
  byId('newCategoriesText').textContent =
    'New in this version: ' + names + ' are skipped from now on. ' + pageCount(matched) +
    ' you saved before ' + (matched === 1 ? 'is' : 'are') + ' from these sites. Remove ' +
    (matched === 1 ? 'it' : 'them') + ', or keep ' + (matched === 1 ? 'it' : 'them') + '?';
  box.hidden = false;
  const settle = (keepExisting) => async () => {
    byId('newCategoriesRemove').disabled = true;
    byId('newCategoriesKeep').disabled = true;
    let removed = 0;
    for (const name of keys) {
      const result = await ask(MSG.REMOVE_EXCLUDED, { scope: 'preset', name, keepExisting }).catch(() => null);
      removed += (result && result.removed) || 0;
    }
    box.hidden = true;
    const note = byId('presetNote');
    note.textContent = keepExisting
      ? 'Kept what you saved before. ' + names + ' are skipped from now on.'
      : 'Removed ' + pageCount(removed) + '. ' + names + ' are skipped from now on.';
    note.hidden = false;
    await refreshUsage();
    await refreshLog();
  };
  byId('newCategoriesRemove').onclick = settle(false);
  byId('newCategoriesKeep').onclick = settle(true);
}
offerNewCategories();

createLanguagePicker(byId('stemLanguages'), {
  selected: settings.stemLanguages,
  onChange: (stemLanguages) => save({ stemLanguages }),
});

const rules = byId('rules');
rules.value = (settings.customRules || []).join('\n');

// The shortcut as Chrome has it, which somebody may have changed, and where
// to change it: Ctrl+Shift+F is also find-in-files in some web editors.
chrome.commands.getAll().then((commands) => {
  const command = commands.find((entry) => entry.name === 'open-search');
  byId('shortcutKeys').textContent = command && command.shortcut ? command.shortcut : 'not set';
}).catch(() => {});
byId('shortcutChange').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
let rulesTimer;
rules.addEventListener('input', () => {
  clearTimeout(rulesTimer);
  // Saving on every keystroke would re-register content scripts constantly,
  // so this waits for a pause instead.
  rulesTimer = setTimeout(async () => {
    const lines = rules.value.split('\n').map((line) => line.trim()).filter(Boolean);
    await save({ customRules: lines });
    describeRules(lines);
    await checkRuleMatches();
  }, 700);
});

// A rule is read the way it was meant, not the way it was typed, and the
// page says how, so nobody is left believing "https://www.example.com/"
// is doing something different from what it does. A line that cannot be an
// address at all is named, because a rule that matches nothing looks exactly
// like one that works.
function describeRules(lines) {
  const note = byId('rulesRead');
  const readAs = [];
  const unusable = [];
  for (const line of lines) {
    const rule = normaliseRule(line);
    const host = rule.split('/')[0];
    if (!rule || /\s/.test(rule) || (!host.includes('.') && !host.endsWith('*') && rule !== '@private-network' && !/^[a-z0-9-]+$/.test(host))) {
      unusable.push(line);
    } else if (rule !== line.toLowerCase()) {
      readAs.push(line + ' as ' + rule);
    }
  }
  const parts = [];
  if (readAs.length) parts.push('Reading ' + readAs.join(', ') + '.');
  if (unusable.length) parts.push("These don't look like a site and won't match anything: " + unusable.join(', ') + '.');
  note.hidden = parts.length === 0;
  note.textContent = parts.join(' ');
}

// Custom rules are saved as they are typed, and a half typed one can match
// far more than was meant ("com" is every .com site), so these only ever
// remove saved pages when asked to.
async function checkRuleMatches() {
  const result = await ask(MSG.REMOVE_EXCLUDED, { scope: 'custom', dryRun: true }).catch(() => null);
  const matched = result && !result.error ? result.matched : 0;
  byId('rulesMatch').hidden = !matched;
  byId('rulesRemove').hidden = false;
  if (matched) {
    byId('rulesMatchText').textContent =
      pageCount(matched) + (matched === 1 ? ' you already saved matches' : ' you already saved match') +
      ' these rules.';
  }
}

byId('rulesRemove').addEventListener('click', async () => {
  const button = byId('rulesRemove');
  button.disabled = true;
  const result = await ask(MSG.REMOVE_EXCLUDED, { scope: 'custom' }).catch(() => null);
  button.disabled = false;
  if (!result || result.error) {
    byId('rulesMatchText').textContent = 'Those pages could not be removed. Try again.';
    return;
  }
  byId('rulesMatchText').textContent = 'Removed ' + pageCount(result.removed) + '.';
  button.hidden = true;
  await refreshUsage();
  await refreshLog();
});

// Only when there are rules to check: this reads every saved address.
if ((settings.customRules || []).length) checkRuleMatches();
describeRules(settings.customRules || []);

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
    note.textContent = 'Type a number to see how much that holds.';
    shrink.hidden = true;
    return;
  }
  note.textContent = 'Room for roughly ' + pagesFor(bytes) + ' pages of typical articles.';
  const over = usedBytes !== null && usedBytes > bytes;
  shrink.hidden = !over;
  if (over) {
    const losing = Math.max(1, Math.round((usedBytes - bytes) / BYTES_PER_PAGE_ESTIMATE));
    shrink.textContent =
      "You're using " + mb(usedBytes) + ', which is more than ' + describeSize(bytes) +
      '. The next cleanup would remove roughly ' + losing.toLocaleString() +
      ' of your oldest pages. Pinned pages are kept.';
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
    "Your saved pages couldn't be opened, so nothing can be shown here. " +
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
      'Your saved pages were moved to a new format on ' + new Date(stats.lastMigration.at).toLocaleDateString() +
      (steps ? ' (' + steps + ')' : '') + '. Everything was checked and nothing was lost.';
    ask(MSG.ACKNOWLEDGE, { what: 'lastMigration' });
  }

  const warnings = [];
  if (stats.storageFull) {
    warnings.push(
      'Your disk ran out of space on ' + new Date(stats.storageFull).toLocaleDateString() +
      ", so new pages weren't saved. Free up some space or lower the size limit above."
    );
  }
  if (stats.persisted === false) {
    warnings.push(
      "Chrome hasn't marked this storage as persistent, so it could clear it if your disk fills up. " +
      'Exporting now and then gives you a backup.'
    );
  }
  // Capture failing is the one failure that leaves no trace to notice later:
  // the pages simply are not there, and an empty result looks like a page you
  // never read rather than one that was never kept.
  const watch = stats.captureWatch;
  if (stats.setupComplete === false) {
    warnings.push("Setup isn't finished, so nothing is being saved yet. Open the extension's button to finish it.");
  }
  if (watch && watch.mode === 'strict') {
    if (watch.ungranted && watch.ungranted.length) {
      warnings.push(
        "These sites are on your list but Chrome hasn't given access to them, so nothing is " +
        'being saved from them: ' + watch.ungranted.join(', ') + '. Remove them and add them again ' +
        'to fix it.'
      );
    }
    if (watch.refused && watch.refused.length) {
      warnings.push(
        'Chrome refused access to ' + watch.refused.join(', ') + ", so nothing is being saved from " +
        'them. Your other sites are fine.'
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
      ? 'The last cleanup skipped the age limit because ' + stats.clockProblem +
        ', so nothing is removed for being too old until the clock has been steady for a day.'
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
  const result = await ask(MSG.MAINTENANCE).catch(() => null);
  byId('dataNote').textContent = !result || result.error || result.unavailable
    ? "Limits couldn't be applied, because the archive couldn't be opened. Nothing was removed."
    : result.evicted ? 'Removed ' + result.evicted + ' pages.' : 'Nothing needed removing.';
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

  // Folded into a Blob a slice at a time rather than kept as strings to the
  // end: Chrome can hold a Blob on disk, and an archive's worth of JSON
  // strings in this page's memory is what an out of memory crash looks like.
  let file = new Blob([]);
  let chunks = [];
  let written = 0;
  let afterId = 0;
  let header = null;

  for (let guard = 0; guard < 100000; guard++) {
    const slice = await ask(MSG.EXPORT, { afterId, limit: EXPORT_BATCH }).catch(() => null);
    if (!slice || slice.error) {
      progress.hidden = true;
      note.textContent = "Your saved pages couldn't be read, so nothing was exported.";
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
    file = new Blob([file, ...chunks]);
    chunks = [];
    if (header.total) {
      fill.style.width = Math.min(100, Math.round((written / header.total) * 100)) + '%';
      note.textContent = 'Exporting… ' + written + ' of ' + header.total;
    }
    if (slice.done || slice.lastId === null) break;
    afterId = slice.lastId;
  }
  const blob = new Blob([file, '\n  ]\n}\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = SLUG + '-' + new Date().toISOString().slice(0, 10) + '.json';
  link.click();
  // Not revoked straight away: the download reads the address after the
  // click returns, and a large file is still being read a moment later.
  setTimeout(() => URL.revokeObjectURL(url), 60000);

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
  const progress = byId('progress');
  const fill = byId('progressFill');

  // Read as a stream, a page at a time, because an export is exactly as big
  // as the archive it came from; see shared/export-reader.js.
  const totals = { imported: 0, skipped: 0, failed: 0, excluded: 0 };
  let format = null;
  let truncated = false;
  let batch = [];
  let seen = 0;

  const send = async () => {
    if (!batch.length) return true;
    const result = await ask(MSG.IMPORT, { pages: batch }).catch(() => null);
    if (!result || result.error) {
      totals.failed += batch.length;
    } else {
      totals.imported += result.imported || 0;
      totals.skipped += result.skipped || 0;
      totals.failed += result.failed || 0;
      totals.excluded += result.excluded || 0;
    }
    batch = [];
    return true;
  };

  try {
    for await (const item of readExport(file.stream())) {
      if (item.type === 'format') {
        format = item.value;
        if (!EXPORT_FORMATS_ACCEPTED.includes(format)) break;
        progress.hidden = false;
        continue;
      }
      if (item.type === 'truncated') {
        truncated = true;
        continue;
      }
      // Nothing is imported from a file that has not said what it is first.
      if (!EXPORT_FORMATS_ACCEPTED.includes(format)) break;
      seen += 1;
      if (item.type === 'bad') totals.failed += 1;
      else batch.push(item.value);
      if (batch.length >= IMPORT_BATCH) await send();
      fill.style.width = Math.min(100, Math.round((item.read / Math.max(1, file.size)) * 100)) + '%';
      note.textContent = 'Importing… ' + (seen === 1 ? '1 page' : seen.toLocaleString() + ' pages') + ' read';
    }
    await send();
  } catch {
    note.textContent = "That file couldn't be read.";
    progress.hidden = true;
    event.target.value = '';
    return;
  }

  progress.hidden = true;
  fill.style.width = '0%';
  event.target.value = '';
  if (!EXPORT_FORMATS_ACCEPTED.includes(format)) {
    note.textContent = 'That does not look like an export from this extension.';
    return;
  }
  const parts = [totals.imported + ' imported'];
  if (totals.skipped) parts.push(totals.skipped + ' already here');
  if (totals.excluded) parts.push(totals.excluded + ' left out because your exclusions cover them');
  if (totals.failed) parts.push(totals.failed + ' could not be read');
  if (truncated) parts.push('the file ended early, so anything after that was not imported');
  note.textContent = parts.join(', ') + '.';
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
  button.disabled = true;
  const result = await ask(MSG.WIPE).catch(() => null);
  button.disabled = false;
  button.dataset.armed = '';
  button.textContent = 'Delete everything';
  byId('dataNote').textContent = result && !result.error
    ? 'Deleted ' + result.deleted + ' pages. Your settings, including your lists of sites, are kept.'
    : "Your saved pages couldn't be deleted. Try again.";
  await refreshUsage();
  await refreshLog();
});

await refreshUsage();
await refreshLog();
