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

if (archiveBroken) {
  const open = byId('open');
  open.textContent = 'Open settings';
  open.onclick = () => {
    chrome.runtime.openOptionsPage();
    window.close();
  };
} else if (stats && !stats.setupComplete) {
  const open = byId('open');
  open.textContent = 'Finish setting up';
  open.onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/setup/setup.html') });
    window.close();
  };
} else {
  byId('open').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/search/search.html') });
    window.close();
  });
}

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
    setStatus('The archive could not be opened. Nothing has been deleted.', true);
    byId('pageUrl').textContent = '';
    return;
  }

  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    setStatus('Nothing to keep here', true);
    byId('pageUrl').textContent = '';
    return;
  }

  const status = await ask(MSG.PAGE_STATUS, { url: tab.url });
  byId('pageUrl').textContent = status.domain || '';

  if (status.kept) {
    const visits = status.kept.visitCount > 1 ? ', ' + status.kept.visitCount + ' visits' : '';
    setStatus('Kept, last read ' + whenText(status.kept.lastSeen) + visits);
    button('Forget this page', '', async () => {
      await ask(MSG.FORGET, { scope: 'page', id: status.kept.id });
      await renderPage();
    });
    button('Never keep this site', 'no', async () => {
      const result = await ask(MSG.BLOCK_SITE, { domain: status.domain });
      setStatus('Never keeping ' + status.domain + (result.removed ? ', ' + pageCount(result.removed) + ' removed' : ''));
      actionsEl.innerHTML = '';
    });
    return;
  }

  // Strict mode, and this site has not been added yet.
  if (status.mode === 'strict' && !status.hasSitePermission) {
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
          await ask(MSG.CAPTURE_NOW, { tabId: tab.id, url: tab.url });
          setStatus('Watching ' + status.domain + ' from now on');
          actionsEl.innerHTML = '';
        });
      event.target.disabled = true;
    });
    return;
  }

  if (!status.capturable) {
    setStatus('Not kept: ' + status.reason, true);
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
    const result = await ask(MSG.CAPTURE_NOW, { tabId: tab.id, url: tab.url });
    if (!result.ok) {
      setStatus('Could not keep this page: ' + result.reason, true);
      return;
    }
    // Extraction happens in the tab and comes back through the worker, so
    // the record does not exist the instant this returns.
    setTimeout(renderPage, 700);
  });
  button('Never keep this site', 'no', async () => {
    const result = await ask(MSG.BLOCK_SITE, { domain: status.domain });
    setStatus('Never keeping ' + status.domain + (result.removed ? ', ' + pageCount(result.removed) + ' removed' : ''));
    actionsEl.innerHTML = '';
  });
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

const recent = archiveBroken ? [] : ((await ask(MSG.RECENT, { limit: 5 }).catch(() => [])) || []);

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
    ? 'The archive could not be opened, so there is nothing to show here. Nothing has been deleted.'
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
