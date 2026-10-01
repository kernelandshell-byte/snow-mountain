import { MSG } from '../../shared/messages.js';
import { whenText } from '../shared/when.js';
import { bytes as size, pageCount } from '../../shared/format.js';
import { t, formatNumber, translatePage } from '../../shared/i18n.js';
import { reasonText } from '../../shared/reasons.js';

translatePage();

const ask = (type, payload) => chrome.runtime.sendMessage({ type, payload });
const byId = (id) => document.getElementById(id);


// The tab is looked up once, at load, so that a click handler can call
// chrome.permissions.request as its very first statement. Awaiting anything
// before that spends the user gesture and Chrome refuses the request.
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const stats = await ask(MSG.STATS).catch(() => null);

// An archive that cannot be opened is not an empty one, and must never be
// described as one. "Finish setting up" and "Nothing kept yet", after a year
// of use, is exactly how somebody decides the extension is broken and throws
// away an archive that was fine.
const archiveBroken = !stats || stats.error || stats.ready === false;

// Normally the popup opens on a search box, so a half remembered phrase can be
// typed the moment it is open. The two states where searching cannot work
// get a single clear button instead.
if (archiveBroken) {
  const open = byId('open');
  open.hidden = false;
  open.textContent = t('popup_open_settings');
  open.onclick = () => {
    chrome.runtime.openOptionsPage();
    window.close();
  };
} else if (stats && !stats.setupComplete) {
  const open = byId('open');
  open.hidden = false;
  open.textContent = t('popup_finish_setup');
  open.onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/setup/setup.html') });
    window.close();
  };
} else {
  const form = byId('searchForm');
  const query = byId('popupQuery');
  form.hidden = false;
  query.focus();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = query.value.trim();
    chrome.tabs.create({
      url: chrome.runtime.getURL('src/ui/search/search.html') + (text ? '?q=' + encodeURIComponent(text) : ''),
    });
    window.close();
  });
}

// The shortcut as Chrome actually has it, which somebody may have changed.
chrome.commands.getAll().then((commands) => {
  const command = commands.find((entry) => entry.name === 'open-search');
  const shortcut = document.querySelector('.shortcut');
  if (!command || !command.shortcut) { shortcut.hidden = true; return; }
  shortcut.innerHTML = '';
  command.shortcut.split('+').forEach((key, index) => {
    if (index) shortcut.append(' ');
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    shortcut.append(kbd);
  });
  shortcut.title = t('popup_shortcut_title');
}).catch(() => {});

byId('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// --- the page in front of you --------------------------------------------

const statusEl = byId('pageStatus');
const actionsEl = byId('pageActions');

function button(label, className, handler) {
  const element = document.createElement('button');
  element.textContent = label;
  if (className) element.className = className;
  element.addEventListener('click', handler);
  actionsEl.appendChild(element);
  return element;
}

function setStatus(text, dim) {
  statusEl.textContent = text;
  statusEl.classList.toggle('dim', !!dim);
}

async function renderPage() {
  actionsEl.innerHTML = '';

  if (archiveBroken) {
    setStatus(t('popup_archive_broken'), true);
    byId('pageUrl').textContent = '';
    return;
  }

  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    setStatus(t('popup_nothing_here'), true);
    byId('pageUrl').textContent = '';
    return;
  }

  const status = await ask(MSG.PAGE_STATUS, { url: tab.url, tabId: tab.id }).catch(() => null);
  if (!status || status.error) {
    setStatus(t('popup_check_failed'), true);
    byId('pageUrl').textContent = '';
    return;
  }
  byId('pageUrl').textContent = status.domain || '';

  if (status.kept) {
    const when = whenText(status.kept.lastSeen);
    setStatus(status.kept.visitCount > 1
      ? t('popup_kept_visits', when, formatNumber(status.kept.visitCount))
      : t('popup_kept', when));
    button(t('popup_forget'), '', async () => {
      await ask(MSG.FORGET, { scope: 'page', id: status.kept.id });
      await renderPage();
    });
    neverKeepButton(status.domain);
    return;
  }

  // Excluded whichever mode is on. Offering to add the site in strict mode
  // would ask Chrome for access to it and then refuse the page anyway.
  if (status.excluded) {
    setStatus(t('popup_not_kept', reasonText(status.excluded)), true);
    // A sign-in key in the address is not a setting anybody can change.
    if (/^excluded\b/.test(status.excluded)) {
      button(t('popup_change_excluded'), '', () => {
        chrome.runtime.openOptionsPage();
        window.close();
      });
    }
    return;
  }

  // Strict mode, and this site has not been added yet: Chrome has not given
  // access to it, or it has (from its own site access menu, or an earlier
  // grant) but the site is not on the list. The second used to end at
  // "Not kept: not on your allowlist" with no way to add it.
  if (status.mode === 'strict' &&
    (!status.hasSitePermission || status.reason === 'not on your allowlist')) {
    setStatus(t('popup_not_watching'), true);
    button(t('popup_keep_site'), 'go', (event) => {
      // First statement in the handler, for the reason at the top of the file.
      chrome.permissions
        .request({ origins: ['*://' + status.domain + '/*', '*://*.' + status.domain + '/*'] })
        .then(async (granted) => {
          if (!granted) {
            setStatus(t('popup_access_refused', status.domain), true);
            // A refused dialog is often a slip. Leave the button live so a
            // second click can ask again, instead of a greyed-out dead end.
            event.target.disabled = false;
            return;
          }
          await ask(MSG.ALLOW_SITE, { domain: status.domain });
          const result = await ask(MSG.CAPTURE_NOW, { tabId: tab.id, url: tab.url });
          actionsEl.innerHTML = '';
          if (!result || !result.ok) {
            // Said plainly, rather than "watching" about a page that was not
            // kept: a pause, or something about this page.
            setStatus(t('popup_watching_not_kept', status.domain,
              reasonText((result && result.reason) || 'it could not be read')), true);
            return;
          }
          setStatus(t('popup_watching', status.domain));
          await settle();
        })
        .catch(() => {
          // Chrome rejects an origin it cannot express as a match pattern
          // (an IPv6 address, for one), and the worker can fail to answer.
          // Said, rather than a dead button.
          setStatus(t('popup_add_failed', status.domain), true);
        });
      event.target.disabled = true;
    });
    return;
  }

  if (!status.capturable) {
    setStatus(t('popup_not_kept', reasonText(status.reason)), true);
    if (status.retryable) {
      button(t('popup_try_again'), 'go', async (event) => {
        event.target.disabled = true;
        const result = await ask(MSG.CAPTURE_NOW, { tabId: tab.id, url: tab.url }).catch(() => null);
        if (!result || !result.ok) {
          setStatus(t('popup_keep_failed', reasonText((result && result.reason) || 'it could not be read')), true);
          return;
        }
        setStatus(t('popup_keeping'), true);
        await settle();
      });
    }
    if (/excluded/.test(status.reason)) {
      button(t('popup_change_excluded'), '', () => {
        chrome.runtime.openOptionsPage();
        window.close();
      });
    }
    return;
  }

  setStatus(t('popup_not_kept_yet'), true);
  button(t('popup_keep_now'), 'go', async (event) => {
    event.target.disabled = true;
    const result = await ask(MSG.CAPTURE_NOW, { tabId: tab.id, url: tab.url }).catch(() => null);
    if (!result || !result.ok) {
      setStatus(t('popup_keep_failed', reasonText((result && result.reason) || 'it could not be read')), true);
      return;
    }
    setStatus(t('popup_keeping'), true);
    await settle();
  });
  neverKeepButton(status.domain);
}

// Blocking a site also deletes what was already kept from it, which cannot
// be undone. When there is anything to delete, the button says how much and
// waits for a second click, the way "Delete everything" does.
function neverKeepButton(domain) {
  let armed = false;
  let timer = null;
  const element = button(t('popup_never_keep'), 'no', async () => {
    if (!armed) {
      const preview = await ask(MSG.BLOCK_SITE, { domain, dryRun: true }).catch(() => null);
      const count = (preview && preview.wouldRemove) || 0;
      if (count > 0) {
        armed = true;
        element.textContent = t('popup_never_confirm', pageCount(count));
        timer = setTimeout(() => {
          armed = false;
          element.textContent = t('popup_never_keep');
        }, 5000);
        return;
      }
    }
    clearTimeout(timer);
    element.disabled = true;
    const result = await ask(MSG.BLOCK_SITE, { domain }).catch(() => null);
    if (!result || result.error) {
      setStatus(t('popup_block_failed', domain), true);
      return;
    }
    setStatus(result.removed
      ? t('popup_never_kept_deleted', domain, pageCount(result.removed))
      : t('popup_never_kept', domain));
    actionsEl.innerHTML = '';
  });
}

// Extraction happens in the tab and comes back through the worker, and a PDF
// is fetched and parsed first, so the answer can take a few seconds. Wait for
// it, and say what it was: kept, or refused and why. Redrawing after a fixed
// delay used to show "Not kept yet" again for a PDF still being read, or for
// a page the worker had refused, with no word about either.
async function settle() {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const status = await ask(MSG.PAGE_STATUS, { url: tab.url, tabId: tab.id }).catch(() => null);
    if (status && (status.kept || !status.capturable)) return renderPage();
  }
  setStatus(t('popup_still_working'), true);
}

await renderPage();

// --- everything else ------------------------------------------------------

// The one thing worth interrupting somebody for: pages are not being kept and
// they have no other way of knowing. Settings explains it at length; here it is
// one sentence, on the surface people actually open.
if (!archiveBroken && stats.storageFull) {
  const alert = byId('alert');
  alert.hidden = false;
  alert.textContent = t('popup_disk_full');
}

if (!archiveBroken && stats.docCount > 0) {
  byId('budgetBlock').hidden = false;
  const fraction = Math.min(1, stats.budget.fraction);
  const fill = byId('fill');
  fill.style.width = Math.max(2, fraction * 100) + '%';
  if (stats.budget.level !== 'ok') fill.classList.add('warn');

  const parts = [t('popup_budget_kept', pageCount(stats.docCount)), t('popup_budget_size', size(stats.usedBytes), size(stats.budget.sizeCapBytes))];
  // A percentage is not actionable. A date is, which is why the pace is
  // measured before anything is said about it. An archive that is already
  // full has no date to give, and projecting one that has already passed is
  // worse than saying nothing.
  if (stats.capUnmeetable) {
    parts.push(t('popup_budget_pinned'));
  } else if (stats.atCap) {
    parts.push(t('budget_full'));
  } else if (stats.exhaustsAt) {
    parts.push(t('budget_full_around', new Date(stats.exhaustsAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })));
  }
  byId('budgetText').textContent = parts.join(' · ');
}

const recent = archiveBroken ? [] : ((await ask(MSG.RECENT, { limit: 5, slim: true }).catch(() => [])) || []);

function recentMarkup(pages) {
  if (Array.isArray(pages) && pages.length) {
    return pages
      .map((page) => {
        const link = document.createElement('a');
        link.href = '#';
        link.dataset.url = page.url;
        link.textContent = page.title || page.url;
        return '<li>' + link.outerHTML + '</li>';
      })
      .join('');
  }
  // The empty case has two very different meanings, and saying the wrong one
  // is how somebody throws away an archive that was fine.
  const li = document.createElement('li');
  li.className = 'host';
  li.textContent = archiveBroken ? t('popup_archive_broken') : t('popup_nothing_kept');
  return li.outerHTML;
}

byId('recent').innerHTML = recentMarkup(recent);

byId('recent').addEventListener('click', (event) => {
  const link = event.target.closest('[data-url]');
  if (!link) return;
  event.preventDefault();
  chrome.tabs.create({ url: link.dataset.url });
  window.close();
});

const pause = byId('pause');
pause.textContent = stats && stats.paused ? t('popup_resume') : t('popup_pause');
pause.addEventListener('click', async () => {
  await ask(MSG.SETTINGS_SET, { pausedUntil: stats && stats.paused ? 0 : Date.now() + 3600000 });
  window.close();
});
