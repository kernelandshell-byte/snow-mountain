// The one control for choosing which languages the search fallback tries,
// shared by setup and settings so the two cannot drift.
//
// Past a handful of languages a flat row of checkboxes stops working, so
// this is a short list with a filter above it. The six offered up front are
// always listed; anything else supported (Dutch, today) is one search away,
// and stays listed once it has been chosen, so nobody's choice is hidden
// from them. Matching is on the English name, the language's own name and
// its code, folded the same way the index folds text, so "francais" finds
// Français.

import {
  STEM_LANGUAGES, FEATURED_LANGUAGES, STEM_LANGUAGE_LABELS, STEM_LANGUAGE_NATIVE,
} from '../../core/stemming.js';
import { foldTerm } from '../../core/tokenizer.js';

// Written without spaces between words, which the tokenizer cannot split
// yet. Named here so that looking for one gets an honest answer instead of
// a bare "no match".
const UNSEGMENTED = [
  'chinese', 'mandarin', 'cantonese', 'zhongwen', '中文', '汉语', '漢語',
  'japanese', 'nihongo', '日本語', 'korean', 'hangul', '한국어', 'thai', 'ไทย',
];

const fold = (text) => foldTerm(String(text || '')).trim();

let instances = 0;

export function createLanguagePicker(root, { selected = [], onChange = () => {} } = {}) {
  const id = 'languages-' + ++instances;
  // Chosen order is kept as given, since it is the order languages are
  // tried in; the list only ever shows them in its own fixed order.
  let chosen = [...new Set(selected.filter((lang) => STEM_LANGUAGES.includes(lang)))];
  // Anything chosen at any point stays listed until the page closes, so
  // unticking Dutch does not make it vanish from under the pointer.
  const listed = new Set(chosen);

  root.classList.add('picker');
  root.innerHTML =
    '<div class="picker-search">' +
    '<input type="search" autocomplete="off" spellcheck="false" ' +
    'placeholder="Find a language" aria-label="Find a language" aria-controls="' + id + '" />' +
    '</div>' +
    '<div class="picker-list" id="' + id + '" role="group" aria-label="Languages"></div>' +
    '<p class="picker-empty" role="status" hidden></p>' +
    '<p class="picker-summary" aria-live="polite"></p>';

  const filter = root.querySelector('input[type="search"]');
  const list = root.querySelector('.picker-list');
  const empty = root.querySelector('.picker-empty');
  const summary = root.querySelector('.picker-summary');

  const matches = (lang, query) =>
    !query ||
    [lang, STEM_LANGUAGE_LABELS[lang], STEM_LANGUAGE_NATIVE[lang]].some((name) => fold(name).includes(query));

  function render() {
    const query = fold(filter.value);
    const shown = STEM_LANGUAGES.filter((lang) =>
      query ? matches(lang, query) : FEATURED_LANGUAGES.includes(lang) || listed.has(lang)
    );

    list.innerHTML = '';
    for (const lang of shown) {
      const label = document.createElement('label');
      label.className = 'picker-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = lang;
      box.dataset.lang = lang;
      box.checked = chosen.includes(lang);
      const name = document.createElement('span');
      name.className = 'picker-name';
      name.textContent = STEM_LANGUAGE_LABELS[lang];
      label.append(box, name);
      if (STEM_LANGUAGE_NATIVE[lang] !== STEM_LANGUAGE_LABELS[lang]) {
        const native = document.createElement('span');
        native.className = 'picker-native';
        native.lang = lang;
        native.textContent = STEM_LANGUAGE_NATIVE[lang];
        label.append(native);
      }
      list.appendChild(label);
    }

    empty.hidden = shown.length > 0;
    if (!shown.length) {
      empty.textContent = UNSEGMENTED.some((name) => fold(name).includes(query) || query.includes(fold(name)))
        ? "Chinese, Japanese, Korean and Thai aren't supported yet. They're written without spaces between words, which search can't split up yet."
        : "That language isn't supported yet. Pages in it are still saved and searchable word for word.";
    }

    summary.textContent = chosen.length
      ? 'Using ' + chosen.map((lang) => STEM_LANGUAGE_LABELS[lang]).join(', ') + '.'
      : "None ticked. Words will only match the way you type them.";
  }

  list.addEventListener('change', (event) => {
    const lang = event.target.dataset.lang;
    if (!lang) return;
    chosen = event.target.checked
      ? [...chosen.filter((entry) => entry !== lang), lang]
      : chosen.filter((entry) => entry !== lang);
    listed.add(lang);
    render();
    // Keep the focus on the box that was just toggled, which render()
    // replaced, so the keyboard does not get thrown back to the top.
    const again = list.querySelector('[data-lang="' + lang + '"]');
    if (again) again.focus();
    onChange([...chosen]);
  });

  filter.addEventListener('input', render);
  filter.addEventListener('keydown', (event) => {
    // Enter picks the only match, which is what somebody who typed
    // "portug" and pressed enter meant.
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const boxes = list.querySelectorAll('input[type="checkbox"]');
    if (boxes.length === 1 && !boxes[0].checked) boxes[0].click();
  });

  render();
  return {
    get value() { return [...chosen]; },
  };
}
