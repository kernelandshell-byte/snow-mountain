import { MSG } from '../../shared/messages.js';
import { bytes as size, pageCount } from '../../shared/format.js';

const ask = (type, payload) => chrome.runtime.sendMessage({ type, payload });
const byId = (id) => document.getElementById(id);

function whenText(timestamp) {
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  if (days < 365) return Math.round(days / 30) + ' months ago';
  return Math.round(days / 365) + ' years ago';
}

// The tab is looked up once, at load, so that a click handler can call
// chrome.permissions.request as its very first statement. Awaiting anything
// before that spends the user gesture and Chrome refuses the request.
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const stats = await ask(MSG.STATS).catch(() => null);

if (stats && !stats.setupComplete) {
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

if (stats && !stats.error && stats.docCount > 0) {
  byId('budgetBlock').hidden = false;
  const fraction = Math.min(1, stats.budget.fraction);
  const fill = byId('fill');
  fill.style.width = Math.max(2, fraction * 100) + '%';
  if (stats.budget.level !== 'ok') fill.classList.add('warn');

  const parts = [pageCount(stats.docCount) + ' kept', size(stats.usedBytes) + ' of ' + size(stats.budget.sizeCapBytes)];
  // A percentage is not actionable. A date is, which is why the pace is
  // measured before anything is said about it.
  if (stats.exhaustsAt) {
    parts.push('full around ' + new Date(stats.exhaustsAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }));
  }
  byId('budgetText').textContent = parts.join(' · ');
}

const recent = (await ask(MSG.RECENT, { limit: 5 }).catch(() => [])) || [];
byId('recent').innerHTML = recent.length
  ? recent
      .map((page) => {
        const link = document.createElement('a');
        link.href = '#';
        link.dataset.url = page.url;
        link.textContent = page.title || page.url;
        return '<li>' + link.outerHTML + '</li>';
      })
      .join('')
  : '<li class="host">Nothing kept yet.</li>';

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
