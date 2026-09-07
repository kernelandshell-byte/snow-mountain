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
};

export function rulesFor(presets = {}, custom = []) {
  const out = [];
  for (const [name, enabled] of Object.entries(presets)) {
    if (enabled && PRESETS[name]) out.push(...PRESETS[name]);
  }
  return [...out, ...custom];
}
