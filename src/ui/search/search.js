import { MSG } from '../../shared/messages.js';
import { textFragmentUrl } from '../../core/text-fragment.js';

const input = document.getElementById('q');
const meta = document.getElementById('meta');
const list = document.getElementById('results');

let rows = [];
let selected = 0;
let sequence = 0;

const ask = (type, payload) => chrome.runtime.sendMessage({ type, payload });

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Highlights arrive as character ranges into the snippet, so the text is
// escaped in pieces and the marks are inserted between them. Building the
// string first and escaping afterwards would escape our own markup.
function highlight(text, ranges) {
  if (!ranges || !ranges.length) return escapeHtml(text);
  const parts = [];
  let cursor = 0;
  for (const [from, to] of ranges) {
    if (from < cursor || to > text.length) continue;
    parts.push(escapeHtml(text.slice(cursor, from)));
    parts.push('<mark>' + escapeHtml(text.slice(from, to)) + '</mark>');
    cursor = to;
  }
  parts.push(escapeHtml(text.slice(cursor)));
  return parts.join('');
}

function whenText(timestamp) {
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return days + ' days ago';
  if (days < 365) return Math.round(days / 30) + ' months ago';
  return Math.round(days / 365) + ' years ago';
}

function render(result) {
  rows = result.results;
  selected = 0;

  const relaxedTerms = Object.entries(result.relaxed || {});
  const notes = [];
  if (result.total) notes.push(result.total + (result.total === 1 ? ' page' : ' pages'));
  if (result.tookMs !== undefined) notes.push(result.tookMs + 'ms');
  if (result.mode === 'or') notes.push('not every word matched, showing the closest');
  for (const [asked, used] of relaxedTerms) notes.push('searched "' + used + '" for "' + asked + '"');
  meta.textContent = notes.join(' · ');

  if (!rows.length) {
    list.innerHTML = '<p class="empty">' +
      (input.value.trim() ? 'Nothing matched.' : 'Type a phrase you remember.') +
      '</p>';
    return;
  }

  list.innerHTML = rows
    .map(
      (row, index) =>
        '<article class="' + (index === 0 ? 'selected' : '') + '" data-index="' + index + '">' +
        '<button class="pin" data-pin="' + index + '" aria-pressed="' + (row.pinned ? 'true' : 'false') + '">' +
        (row.pinned ? 'pinned' : 'pin') + '</button>' +
        '<h2><a href="#" data-open="' + index + '">' + escapeHtml(row.title || row.url) + '</a></h2>' +
        '<p class="source">' + escapeHtml(row.domain || '') + ' · ' + whenText(row.lastSeen) + '</p>' +
        '<p class="snippet">' + highlight(row.snippet.text, row.snippet.ranges) + '</p>' +
        '</article>'
    )
    .join('');
}

function select(next) {
  if (!rows.length) return;
  selected = Math.max(0, Math.min(rows.length - 1, next));
  for (const article of list.querySelectorAll('article')) {
    article.classList.toggle('selected', Number(article.dataset.index) === selected);
  }
  list.querySelector('article.selected').scrollIntoView({ block: 'nearest' });
}

// The spike settled this: a fragment only fires on a fresh document load, so
// results always open in a new tab. Whether the passage was found is not
// something we can know, and not something worth claiming.
function open(index, background) {
  const row = rows[index];
  if (!row) return;
  chrome.tabs.create({
    url: textFragmentUrl(row.url, row.snippet.text, row.snippet.ranges),
    active: !background,
  });
}

async function run() {
  const query = input.value;
  const mine = ++sequence;
  const result = await ask(MSG.SEARCH, { query, limit: 25 });
  // A slower earlier query must never overwrite a newer one's results.
  if (mine !== sequence) return;
  render(result || { results: [], total: 0 });
}

let debounce;
input.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(run, 90);
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') { event.preventDefault(); select(selected + 1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); select(selected - 1); }
  else if (event.key === 'Enter') { event.preventDefault(); open(selected, event.metaKey || event.ctrlKey); }
});

list.addEventListener('click', async (event) => {
  const openTarget = event.target.closest('[data-open]');
  if (openTarget) {
    event.preventDefault();
    open(Number(openTarget.dataset.open), event.metaKey || event.ctrlKey);
    return;
  }
  const pinTarget = event.target.closest('[data-pin]');
  if (pinTarget) {
    const row = rows[Number(pinTarget.dataset.pin)];
    const next = !row.pinned;
    await ask(MSG.PIN, { id: row.id, pinned: next });
    row.pinned = next;
    pinTarget.setAttribute('aria-pressed', next ? 'true' : 'false');
    pinTarget.textContent = next ? 'pinned' : 'pin';
  }
});

const initial = new URLSearchParams(location.search).get('q');
if (initial) {
  input.value = initial;
  run();
} else {
  render({ results: [], total: 0 });
}
