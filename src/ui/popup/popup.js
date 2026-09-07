import { MSG } from '../../shared/messages.js';

const ask = (type, payload) => chrome.runtime.sendMessage({ type, payload });
const byId = (id) => document.getElementById(id);
const mb = (bytes) => (bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0) + 'MB';

byId('open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/search/search.html') });
  window.close();
});

byId('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

const stats = await ask(MSG.STATS).catch(() => null);

if (!stats || stats.error) {
  byId('status').textContent = 'Storage is not available right now.';
} else {
  const pages = stats.docCount === 1 ? '1 page kept' : stats.docCount + ' pages kept';
  byId('status').textContent = stats.paused ? pages + ' · paused' : pages;

  if (stats.docCount > 0) {
    byId('budget').hidden = false;
    const fraction = Math.min(1, stats.budget.fraction);
    const fill = byId('fill');
    fill.style.width = Math.max(2, fraction * 100) + '%';
    if (stats.budget.level !== 'ok') fill.classList.add('warn');

    const parts = [mb(stats.usedBytes) + ' of ' + mb(stats.budget.sizeCapBytes)];
    // A percentage is not actionable. A date is, which is the whole point of
    // measuring the pace before saying anything.
    if (stats.exhaustsAt) {
      parts.push(
        'full around ' +
          new Date(stats.exhaustsAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
      );
    }
    byId('budgetText').textContent = parts.join(' · ');
  }
}

const recent = (await ask(MSG.RECENT, { limit: 6 }).catch(() => [])) || [];
byId('recent').innerHTML = recent.length
  ? recent
      .map(
        (page) =>
          '<li><a href="#" data-url="' + encodeURI(page.url) + '">' +
          (page.title || page.url).replace(/[<>&]/g, '') +
          '</a><span class="host">' + (page.domain || '') + '</span></li>'
      )
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
  const pausedUntil = stats && stats.paused ? 0 : Date.now() + 3600000;
  await ask(MSG.SETTINGS_SET, { pausedUntil });
  window.close();
});
