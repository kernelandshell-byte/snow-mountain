import { MSG } from '../../shared/messages.js';
import { whenText } from '../shared/when.js';
import { bytes as size, pageCount } from '../../shared/format.js';

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
  open.textContent = 'Open settings';
  open.onclick = () => {
    chrome.runtime.openOptionsPage();
    window.close();
  };
} else if (stats && !stats.setupComplete) {
  const open = byId('open');
  open.hidden = false;
  open.textContent = 'Finish setting up';
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
  shortcut.title = 'Opens search from anywhere';
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

// "excluded: example.com" is how the policy says it; the domain is already
// on screen under the status line.
const reasonText = (reason) => (/^excluded\b/.test(reason || '') ? 'excluded in your settings' : reason);

function setStatus(text, dim) {
  statusEl.textContent = text;
  statusEl.classList.toggle('dim', !!dim);
}

async function renderPage() {
  actionsEl.innerHTML = '';

  if (archiveBroken) {
    setStatus("Your saved pages couldn't be opened. Nothing has been deleted.", true);
    byId('pageUrl').textContent = '';
    return;
  }

  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    setStatus('Nothing to keep here', true);
    byId('pageUrl').textContent = '';
    return;
  }

  const status = await ask(MSG.PAGE_STATUS, { url: tab.url, tabId: tab.id }).catch(() => null);
  if (!status || status.error) {
    setStatus("Couldn't check this page. Nothing has been changed.", true);
    byId('pageUrl').textContent = '';
    return;
  }
  byId('pageUrl').textContent = status.domain || '';

  if (status.kept) {
    const visits = status.kept.visitCount > 1 ? ', ' + status.kept.visitCount + ' visits' : '';
    setStatus('Kept, last read ' + whenText(status.kept.lastSeen) + visits);
    button('Forget this page', '', async () => {
      await ask(MSG.FORGET, { scope: 'page', id: status.kept.id });
      await renderPage();
    });
    neverKeepButton(status.domain);
    return;
  }

  // Excluded whichever mode is on. Offering to add the site in strict mode
  // would ask Chrome for access to it and then refuse the page anyway.
  if (status.excluded) {
    setStatus('Not kept: ' + reasonText(status.excluded), true);
    // A sign-in key in the address is not a setting anybody can change.
    if (/^excluded\b/.test(status.excluded)) {
      button('Change what is excluded', '', () => {
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
    setStatus('Not watching this site', true);
    button('Keep pages from this site', 'go', (event) => {
      // First statement in the handler, for the reason at the top of the file.
      chrome.permissions
        .request({ origins: ['*://' + status.domain + '/*', '*://*.' + status.domain + '/*'] })
        .then(async (granted) => {
          if (!granted) {
            setStatus('Chrome did not grant access to ' + status.domain, true);
            return;
          }
          await ask(MSG.ALLOW_SITE, { domain: status.domain });
          const result = await ask(MSG.CAPTURE_NOW, { tabId: tab.id, url: tab.url });
          actionsEl.innerHTML = '';
          if (!result || !result.ok) {
            // Said plainly, rather than "watching" about a page that was not
            // kept: a pause, or something about this page.
            setStatus('Watching ' + status.domain + ' from now on. This page was not kept: ' +
              ((result && result.reason) || 'it could not be read'), true);
            return;
          }
          setStatus('Watching ' + status.domain + ' from now on');
          await settle();
        })
        .catch(() => {
          // Chrome rejects an origin it cannot express as a match pattern
          // (an IPv6 address, for one), and the worker can fail to answer.
          // Said, rather than a dead button.
          setStatus("Couldn't add " + status.domain + '. Open this again to try once more.', true);
        });
      event.target.disabled = true;
    });
    return;
  }

  if (!status.capturable) {
    setStatus('Not kept: ' + reasonText(status.reason), true);
    if (status.retryable) {
      button('Try again', 'go', async (event) => {
        event.target.disabled = true;
        const result = await ask(MSG.CAPTURE_NOW, { tabId: tab.id, url: tab.url }).catch(() => null);
        if (!result || !result.ok) {
          setStatus('Could not keep this page: ' + ((result && result.reason) || 'it could not be read'), true);
          return;
        }
        setStatus('Keeping this page…', true);
        await settle();
      });
    }
    if (/excluded/.test(status.reason)) {
      button('Change what is excluded', '', () => {
        chrome.runtime.openOptionsPage();
        window.close();
      });
    }
    return;
  }

  setStatus('Not kept yet', true);
  button('Keep this page now', 'go', async (event) => {
    event.target.disabled = true;
    const result = await ask(MSG.CAPTURE_NOW, { tabId: tab.id, url: tab.url }).catch(() => null);
    if (!result || !result.ok) {
      setStatus('Could not keep this page: ' + ((result && result.reason) || 'it could not be read'), true);
      return;
    }
    setStatus('Keeping this page…', true);
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
  const element = button('Never keep this site', 'no', async () => {
    if (!armed) {
      const preview = await ask(MSG.BLOCK_SITE, { domain, dryRun: true }).catch(() => null);
      const count = (preview && preview.wouldRemove) || 0;
      if (count > 0) {
        armed = true;
        element.textContent = 'Also deletes ' + pageCount(count) + '. Click again';
        timer = setTimeout(() => {
          armed = false;
          element.textContent = 'Never keep this site';
        }, 5000);
        return;
      }
    }
    clearTimeout(timer);
    element.disabled = true;
    const result = await ask(MSG.BLOCK_SITE, { domain }).catch(() => null);
    if (!result || result.error) {
      setStatus("Couldn't block " + domain + '. Nothing was changed.', true);
      return;
    }
    setStatus('Never keeping ' + domain + (result.removed ? ', ' + pageCount(result.removed) + ' deleted' : ''));
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
  setStatus('Still working on this page. Open this again in a moment to see whether it was kept.', true);
}

await renderPage();

// --- everything else ------------------------------------------------------

// The one thing worth interrupting somebody for: pages are not being kept and
// they have no other way of knowing. Settings explains it at length; here it is
// one sentence, on the surface people actually open.
if (!archiveBroken && stats.storageFull) {
  const alert = byId('alert');
  alert.hidden = false;
  alert.textContent =
    'This disk ran out of room, so pages are not being kept. Settings has what to do about it.';
}

if (!archiveBroken && stats.docCount > 0) {
  byId('budgetBlock').hidden = false;
  const fraction = Math.min(1, stats.budget.fraction);
  const fill = byId('fill');
  fill.style.width = Math.max(2, fraction * 100) + '%';
  if (stats.budget.level !== 'ok') fill.classList.add('warn');

  const parts = [pageCount(stats.docCount) + ' kept', size(stats.usedBytes) + ' of ' + size(stats.budget.sizeCapBytes)];
  // A percentage is not actionable. A date is, which is why the pace is
  // measured before anything is said about it. An archive that is already
  // full has no date to give, and projecting one that has already passed is
  // worse than saying nothing.
  if (stats.capUnmeetable) {
    parts.push('more is pinned than fits');
  } else if (stats.atCap) {
    parts.push('full, oldest pages being replaced');
  } else if (stats.exhaustsAt) {
    parts.push('full around ' + new Date(stats.exhaustsAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }));
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
  li.textContent = archiveBroken
    ? "Your saved pages couldn't be opened. Nothing has been deleted."
    : 'Nothing kept yet.';
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
pause.textContent = stats && stats.paused ? 'Resume capturing' : 'Pause for an hour';
pause.addEventListener('click', async () => {
  await ask(MSG.SETTINGS_SET, { pausedUntil: stats && stats.paused ? 0 : Date.now() + 3600000 });
  window.close();
});
