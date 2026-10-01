// Why a page was not kept, said in words.
//
// The worker reports a reason as a short English code ("paused", "not on your
// allowlist"), and the capture policy, its tests and the outcome records all
// rely on those exact strings, so they stay as they are. This is the one place
// they become something a person reads, in the language of the interface. A
// reason it does not know is shown as it came, which is better than hiding it.

import { t } from './i18n.js';

const KEYS = {
  'incognito': 'reason_incognito',
  'setup is not finished': 'reason_setup',
  'paused': 'reason_paused',
  'unparseable url': 'reason_unparseable',
  'not a web page': 'reason_not_web',
  'a password or payment field on the page': 'reason_password',
  'the address contains a sign-in or access key': 'reason_secret_url',
  'not on your allowlist': 'reason_allowlist',
  'no address': 'reason_no_address',
  'the address does not match the page that sent it': 'reason_address_mismatch',
  'still reading': 'reason_still_reading',
  'the page could not be read': 'reason_unreadable',
  'nothing to index': 'reason_nothing',
  'too little text to be worth finding later': 'reason_too_little',
  'there is no room left on this disk': 'reason_disk_full',
  'could not read this pdf': 'reason_pdf_unreadable',
  'this pdf is too large to keep (over 20MB)': 'reason_pdf_large',
  'this tab has moved on to another page': 'reason_tab_moved',
  'could not read this tab': 'reason_tab_unreadable',
  'it could not be read': 'reason_default',
};

// "excluded: example.com" is how the policy says it; the domain is already on
// screen under the status line.
export function reasonText(reason) {
  if (/^excluded\b/.test(reason || '')) return t('reason_excluded');
  const key = KEYS[reason];
  return key ? t(key) : reason;
}
