// Shipped exclusion bundles. Each is toggled as a group in setup, and the
// lists are maintained here rather than being typed by the user.
//
// These are starting points, not a claim of completeness. The custom rules
// field exists because no shipped list survives contact with real browsing.

export const PRESETS = {
  webmail: [
    'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
    'mail.yahoo.com', 'mail.proton.me', 'app.fastmail.com', 'webmail.*',
  ],
  banking: [
    '*.paypal.com', 'banking.*', '*.revolut.com', '*.wise.com', '*.n26.com',
    '*.ing.de', '*.commerzbank.de', '*.sparkasse.de', '*.csob.cz', '*.kb.cz',
  ],
  health: [
    '*.mychart.com', 'patient.*', '*.zocdoc.com', '*.doctolib.de', '*.jameda.de',
  ],
  adult: [],
  government: [
    '*.gov', '*.gov.uk', '*.gov.cz', '*.bund.de', 'mojedatovaschranka.cz',
  ],
  intranet: ['localhost', '*.local', '*.internal', '*.lan'],
  // matchesRule strips a leading "www." from the real URL before comparing,
  // so a bare host already covers its www subdomain -- a "www.<host>" entry
  // here would only ever compare against an already-stripped host and could
  // never match anything.
  searchResults: [
    'google.com/search', 'google.de/search', 'google.nl/search',
    'bing.com/search', 'duckduckgo.com', 'search.brave.com', 'ecosia.org/search',
    'startpage.com/sp/search', 'search.marcia.com',
  ],
};

// Shown in setup. Kept beside the lists so a bundle can never be added
// without a human readable description of what it stops.
export const PRESET_LABELS = {
  webmail: { title: 'Webmail', example: 'Gmail, Outlook, Proton' },
  banking: { title: 'Banking and payments', example: 'PayPal, Revolut, your bank' },
  health: { title: 'Health and medical', example: 'patient portals, booking' },
  adult: { title: 'Adult sites', example: '' },
  government: { title: 'Government and ID portals', example: 'tax, registration' },
  intranet: { title: 'Local and internal', example: 'localhost, company intranets' },
  searchResults: { title: 'Search results pages', example: 'Google, Bing, DuckDuckGo' },
};

// Defensive about both arguments. Settings are normalised before they get
// here, but this is the function that decides what is never read, and a
// throw inside it would take the whole capture policy down with it.
export function rulesFor(presets, custom) {
  const out = [];
  if (presets && typeof presets === 'object') {
    for (const [name, enabled] of Object.entries(presets)) {
      if (enabled && PRESETS[name]) out.push(...PRESETS[name]);
    }
  }
  const extra = Array.isArray(custom) ? custom.filter((rule) => typeof rule === 'string' && rule) : [];
  return [...out, ...extra];
}
