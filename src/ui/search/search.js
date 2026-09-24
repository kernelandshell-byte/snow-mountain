import { MSG } from '../../shared/messages.js';
import { whenText } from '../shared/when.js';
import { phraseFrom } from '../../core/text-fragment.js';

const PAGE_SIZE = 20;

const input = document.getElementById('q');
const meta = document.getElementById('meta');
const announcer = document.getElementById('announce');
const list = document.getElementById('results');
const filters = document.getElementById('filters');
const siteSelect = document.getElementById('site');
const whenSelect = document.getElementById('when');
const moreButton = document.getElementById('more');
const sentinel = document.getElementById('sentinel');

// The worker can answer with an error, and the message itself can fail if
// the worker is being restarted. Neither should leave a blank page with no
// explanation, which is what an unhandled rejection here would produce.
const ask = (type, payload) =>
  chrome.runtime.sendMessage({ type, payload }).catch((error) => ({
    error: String((error && error.message) || error),
  }));

let rows = [];
let selected = 0;
let sequence = 0;
let loading = false;
let state = { site: '', days: '', sort: 'relevance', total: 0, hasMore: false };

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Highlights arrive as character ranges into the snippet, so the text is
// escaped in pieces and the marks inserted between them. Building the string
// first and escaping afterwards would escape our own markup.
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


function cardFor(row, index) {
  return (
    // The pin comes last in the markup and is lifted into the corner by CSS.
    // On a narrow window it stays where it is, after the result rather than
    // ahead of its own title, which is also the order anything reading this
    // aloud should hear it in.
    '<article class="' + (index === selected ? 'selected' : '') + (row.recent ? ' recent-item' : '') +
    '" data-index="' + index + '">' +
    // A real address, so a middle click, a ctrl click, "copy link" and the
    // status bar all do what they do on any other link. A plain click is
    // taken over below, to land on the passage.
    '<h2><a href="' + escapeHtml(row.url) + '" data-open="' + index + '">' + escapeHtml(row.title || row.url) + '</a></h2>' +
    '<p class="source">' + escapeHtml(row.domain || '') +
    '<span class="dot">·</span>' + whenText(row.lastSeen) + '</p>' +
    '<p class="snippet">' + highlight(row.snippet.text, row.snippet.ranges) + '</p>' +
    '<button class="pin" data-pin="' + index + '" aria-pressed="' + (row.pinned ? 'true' : 'false') + '"' +
    ' title="Pinned pages are never removed to make room">' +
    (row.pinned ? 'Pinned' : 'Pin') + '</button>' +
    '</article>'
  );
}

function renderMeta(result) {
  const notes = [];
  if (result.total) notes.push(result.total === 1 ? '1 page' : result.total + ' pages');
  else notes.push('nothing matched');
  if (result.tookMs !== undefined) notes.push(result.tookMs + 'ms');
  if (result.mode === 'or') notes.push('not every word matched');
  for (const [asked, used] of Object.entries(result.relaxed || {})) {
    notes.push('searched "' + used + '" for "' + asked + '"');
  }
  // A widened word has to be visible. Showing results for words the person
  // did not type, without saying which, is the search quietly answering a
  // different question.
  for (const [asked, words] of Object.entries(result.expanded || {})) {
    const shown = words.slice(0, 3).join(', ');
    const more = words.length > 3 ? ' and ' + (words.length - 3) + ' more' : '';
    notes.push('"' + asked + '" matched ' + shown + more);
  }
  meta.textContent = notes.join(' · ');
}

function renderSites(domains) {
  const previous = siteSelect.value;
  siteSelect.innerHTML =
    '<option value="">All sites</option>' +
    domains
      .map((entry) => '<option value="' + escapeHtml(entry.domain) + '">' +
        escapeHtml(entry.domain) + ' (' + entry.count + ')</option>')
      .join('');
  // Keep a chosen site selected even when it is no longer in the top few.
  if (previous) {
    if (![...siteSelect.options].some((option) => option.value === previous)) {
      siteSelect.insertAdjacentHTML('beforeend',
        '<option value="' + escapeHtml(previous) + '">' + escapeHtml(previous) + '</option>');
    }
    siteSelect.value = previous;
  }
}

function filterPayload() {
  return {
    site: state.site || null,
    after: state.days ? Date.now() - Number(state.days) * 86400000 : null,
    sort: state.sort,
  };
}

async function run({ append = false } = {}) {
  const query = input.value;
  if (!query.trim()) {
    rows = [];
    filters.hidden = true;
    moreButton.hidden = true;
    meta.textContent = '';
    const mine = ++sequence;
    await showRecent(mine);
    return;
  }

  const mine = ++sequence;
  loading = true;
  const result = await ask(MSG.SEARCH, {
    query,
    limit: PAGE_SIZE,
    offset: append ? rows.length : 0,
    filters: filterPayload(),
  });
  loading = false;
  // A slower earlier query must never overwrite a newer one's results.
  if (mine !== sequence) return;

  if (!result || result.error || !Array.isArray(result.results)) {
    rows = [];
    filters.hidden = true;
    moreButton.hidden = true;
    meta.textContent = '';
    list.innerHTML =
      '<p class="empty"><strong>Search is not available right now.</strong>' +
      'Reloading this page usually fixes it.</p>';
    return;
  }

  state.total = result.total;
  state.hasMore = result.hasMore;

  if (append) {
    rows = rows.concat(result.results);
    list.insertAdjacentHTML('beforeend', result.results.map((row, i) => cardFor(row, rows.length - result.results.length + i)).join(''));
  } else {
    rows = result.results;
    selected = 0;
    list.innerHTML = rows.length
      ? rows.map(cardFor).join('')
      : '<p class="empty"><strong>Nothing matched.</strong>' +
        "Try fewer words, or just the one you're surest of. Only pages read since setup " +
        'can be found.</p>';
  }

  renderMeta(result);
  renderSites(result.domains || []);
  filters.hidden = rows.length === 0 && !state.site && !state.days;
  moreButton.hidden = !state.hasMore;
}

const TIP =
  'Any words from the page, in any order. Add <code>site:example.com</code> to narrow it ' +
  'down, put "quotation marks" around an exact phrase, or write <code>-word</code> to leave ' +
  'pages with that word out.';

// Before anything is typed: what you read lately, so the page is useful the
// moment it opens, and a plain word on day one about why it is empty.
async function showRecent(mine) {
  const [recent, stats] = await Promise.all([
    ask(MSG.RECENT, { limit: 8, slim: true }),
    ask(MSG.STATS),
  ]);
  if (mine !== sequence || input.value.trim()) return;

  const count = stats && !stats.error && typeof stats.docCount === 'number' ? stats.docCount : null;
  if (count === 0) {
    list.innerHTML =
      "<p class=\"empty\"><strong>Nothing saved yet.</strong>Pages show up here once you've " +
      'spent a few seconds reading them. Come back after some browsing.</p>';
    return;
  }

  meta.textContent = count ? (count === 1 ? '1 page saved' : count.toLocaleString() + ' pages saved') : '';
  rows = Array.isArray(recent)
    ? recent.map((page) => ({ ...page, recent: true, snippet: { text: '', ranges: [] } }))
    : [];
  selected = 0;
  list.innerHTML =
    '<p class="empty"><strong>Type a phrase you remember.</strong>' + TIP + '</p>' +
    (rows.length ? '<p class="recent-head">Recently read</p>' + rows.map(cardFor).join('') : '');
}

function select(next) {
  if (!rows.length) return;
  selected = Math.max(0, Math.min(rows.length - 1, next));
  for (const article of list.querySelectorAll('article')) {
    article.classList.toggle('selected', Number(article.dataset.index) === selected);
  }
  const current = list.querySelector('article.selected');
  if (current) current.scrollIntoView({ block: 'nearest' });
  // The arrow keys move a highlight, not the focus, so typing can carry on.
  // A highlight is invisible to a screen reader, so the move is said aloud.
  const row = rows[selected];
  if (announcer && row) {
    announcer.textContent = (selected + 1) + ' of ' + rows.length + ': ' + (row.title || row.url) +
      ', ' + (row.domain || '');
  }
}

// The worker decides how to open it: a text fragment for a fresh tab, the
// highlight script for a tab already sitting on the page. All this page has
// to do is say which passage matched.
function open(index) {
  const row = rows[index];
  if (!row) return;
  ask(MSG.OPEN_RESULT, {
    url: row.url,
    quote: phraseFrom(row.snippet.text, row.snippet.ranges),
  });
}

let debounce;
input.addEventListener('input', () => {
  // The recent list answers "what did I read lately", not what is being
  // typed, so it goes the moment typing starts rather than sitting under a
  // query it has nothing to do with until the results arrive.
  if (input.value.trim() && rows.length && rows[0].recent) {
    rows = [];
    list.innerHTML = '';
    meta.textContent = '';
  }
  clearTimeout(debounce);
  debounce = setTimeout(() => run(), 90);
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') { event.preventDefault(); select(selected + 1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); select(selected - 1); }
  else if (event.key === 'Enter') { event.preventDefault(); open(selected); }
  else if (event.key === 'Escape') { if (input.value) { input.value = ''; run(); } }
});

siteSelect.addEventListener('change', () => { state.site = siteSelect.value; run(); });
whenSelect.addEventListener('change', () => { state.days = whenSelect.value; run(); });

document.querySelector('.sort').addEventListener('click', (event) => {
  const button = event.target.closest('[data-sort]');
  if (!button || button.dataset.sort === state.sort) return;
  state.sort = button.dataset.sort;
  for (const other of document.querySelectorAll('[data-sort]')) {
    other.classList.toggle('on', other === button);
  }
  run();
});

moreButton.addEventListener('click', () => run({ append: true }));

// Loading the next page on scroll, with the button as the fallback for
// anyone who prefers to ask for it.
new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.hasMore && !loading) run({ append: true });
}).observe(sentinel);

list.addEventListener('click', async (event) => {
  const openTarget = event.target.closest('[data-open]');
  if (openTarget) {
    // A modified click is somebody asking for the link as a link.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open(Number(openTarget.dataset.open));
    return;
  }
  const pinTarget = event.target.closest('[data-pin]');
  if (pinTarget) {
    const row = rows[Number(pinTarget.dataset.pin)];
    const next = !row.pinned;
    // Only shown as pinned once it is: a page swept away since the search,
    // or a worker that did not answer, must not look protected when it is not.
    const done = await ask(MSG.PIN, { id: row.id, pinned: next });
    if (done !== true) return;
    row.pinned = next;
    pinTarget.setAttribute('aria-pressed', next ? 'true' : 'false');
    pinTarget.textContent = next ? 'Pinned' : 'Pin';
  }
});

const initial = new URLSearchParams(location.search).get('q');
if (initial) input.value = initial;
run();
