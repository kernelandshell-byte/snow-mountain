// Shipped exclusion bundles. Each is toggled as a group in setup, and the
// lists are maintained here rather than being typed by the user.
//
// These are starting points, not a claim of completeness. The custom rules
// field exists because no shipped list survives contact with real browsing,
// and the interface says so.
//
// How to write an entry (see matchesRule in core/capture-policy.js):
//   paypal.com         the domain, its www. and every subdomain. Almost
//                      every entry should look like this.
//   *.example.com      subdomains only, never the bare domain. Easy to get
//                      wrong: the matcher strips "www." first, so
//                      "*.paypal.com" misses www.paypal.com. Avoid.
//   google.*           any host whose first label is "google", on any
//                      country domain: google.com, google.co.il, ...
//   gov.uk             a public suffix works the same way as a domain: every
//                      site under it.
//   @private-network   IP addresses on a local network, and single-label
//                      hosts like http://wiki/.

export const PRESETS = {
  webmail: [
    'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
    'mail.yahoo.com', 'mail.aol.com', 'mail.proton.me', 'app.fastmail.com',
    'mail.zoho.com', 'mail.zoho.eu', 'icloud.com/mail*', 'mail.gmx.net', 'mail.gmx.com',
    'web.de', 'mail.yandex.ru', 'tuta.com', 'app.tuta.com', 'mail.tutanota.com',
    'webmail.*', 'mail.seznam.cz', 'email.seznam.cz', 'posteo.de', 'mailbox.org',
  ],

  messaging: [
    'web.whatsapp.com', 'messenger.com', 'facebook.com/messages/*', 'instagram.com/direct/*',
    'linkedin.com/messaging/*', 'web.telegram.org', 'discord.com/channels/*',
    'app.slack.com', 'teams.microsoft.com', 'teams.live.com', 'chat.google.com',
    'mail.google.com/chat/*', 'messages.google.com', 'x.com/messages/*', 'twitter.com/messages/*',
    'x.com/i/chat/*', 'reddit.com/message/*', 'reddit.com/chat/*', 'chat.reddit.com',
    'app.element.io', 'web.skype.com', 'web.wechat.com', 'wx.qq.com', 'web.snapchat.com',
  ],

  // Conversations with an AI assistant are among the most personal text a
  // browser ever shows, and they are long and read slowly, which is exactly
  // what the read heuristic rewards.
  aiChats: [
    'chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'bard.google.com',
    'copilot.microsoft.com', 'copilot.cloud.microsoft', 'm365.cloud.microsoft/chat*',
    'perplexity.ai', 'poe.com', 'character.ai', 'chat.mistral.ai', 'chat.deepseek.com',
    'grok.com', 'x.com/i/grok*', 'meta.ai', 'pi.ai', 'huggingface.co/chat/*', 'chat.qwen.ai',
    'kimi.com', 'you.com',
  ],

  // Password managers show secrets as ordinary text once revealed, and
  // account pages list the details somebody signs in with.
  accounts: [
    'vault.bitwarden.com', 'vault.bitwarden.eu', 'my.1password.com', 'my.1password.eu',
    'my.1password.ca', '1password.com/vaults*', 'lastpass.com', 'app.dashlane.com',
    'keepersecurity.com', 'keepersecurity.eu', 'pass.proton.me', 'account.proton.me',
    'nordpass.com', 'app.nordpass.com', 'roboform.com', 'app.enpass.io',
    'myaccount.google.com', 'accounts.google.com', 'passwords.google.com',
    'account.microsoft.com', 'account.live.com', 'login.live.com', 'login.microsoftonline.com',
    'mysignins.microsoft.com', 'appleid.apple.com', 'account.apple.com', 'icloud.com/keychain*',
    'accountscenter.facebook.com', 'facebook.com/settings*', 'x.com/settings/*',
    'github.com/settings/*', 'login.yahoo.com', 'id.atlassian.com',
  ],

  banking: [
    // Payments and money apps.
    'paypal.com', 'revolut.com', 'wise.com', 'transferwise.com', 'n26.com', 'monzo.com',
    'starlingbank.com', 'bunq.com', 'klarna.com', 'venmo.com', 'cash.app', 'stripe.com/dashboard/*',
    'dashboard.stripe.com', 'squareup.com/dashboard/*', 'payoneer.com', 'skrill.com',
    'coinbase.com', 'kraken.com', 'binance.com', 'robinhood.com', 'etoro.com', 'trading212.com',
    'vanguard.com', 'fidelity.com', 'schwab.com', 'etrade.com', 'interactivebrokers.com',
    // United States.
    'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'citibank.com',
    'capitalone.com', 'usbank.com', 'pnc.com', 'truist.com', 'td.com', 'tdbank.com',
    'americanexpress.com', 'discover.com', 'ally.com', 'sofi.com', 'chime.com', 'navyfederal.org',
    'usaa.com', 'synchrony.com', 'mysynchrony.com', 'regions.com', 'key.com', 'fifththird.com',
    'citizensbank.com', 'huntington.com', 'mtb.com', 'santanderbank.com', 'hsbc.com',
    // United Kingdom and Ireland.
    'barclays.co.uk', 'hsbc.co.uk', 'lloydsbank.com', 'natwest.com', 'santander.co.uk',
    'halifax.co.uk', 'nationwide.co.uk', 'rbs.co.uk', 'tsb.co.uk', 'firstdirect.com',
    'metrobankonline.co.uk', 'bankofscotland.co.uk', 'aib.ie', 'bankofireland.com',
    // Germany, Austria, Switzerland.
    'sparkasse.de', 'sparkasse.at', 'deutsche-bank.de', 'db.com', 'commerzbank.de', 'ing.de',
    'dkb.de', 'comdirect.de', 'postbank.de', 'consorsbank.de', 'hypovereinsbank.de',
    'volksbank.de', 'vr.de', 'targobank.de', 'erstebank.at', 'raiffeisen.at', 'bankaustria.at',
    'ubs.com', 'credit-suisse.com', 'postfinance.ch', 'raiffeisen.ch', 'zkb.ch',
    // Netherlands, Belgium, France, Spain, Italy, Portugal, Nordics.
    'ing.nl', 'abnamro.nl', 'rabobank.nl', 'snsbank.nl', 'asnbank.nl', 'knab.nl', 'ing.be',
    'kbc.be', 'belfius.be', 'bnpparibasfortis.be', 'bnpparibas', 'mabanque.bnpparibas',
    'credit-agricole.fr', 'societegenerale.fr', 'labanquepostale.fr', 'caisse-epargne.fr',
    'banquepopulaire.fr', 'lcl.fr', 'boursorama.com', 'santander.es', 'bbva.es', 'caixabank.es',
    'bancosabadell.com', 'bankinter.com', 'intesasanpaolo.com', 'unicredit.it', 'poste.it',
    'bancobpm.it', 'finecobank.com', 'cgd.pt', 'millenniumbcp.pt', 'novobanco.pt',
    'nordea.com', 'nordea.se', 'nordea.fi', 'nordea.dk', 'nordea.no', 'seb.se', 'swedbank.se',
    'handelsbanken.se', 'danskebank.dk', 'danskebank.com', 'dnb.no', 'op.fi',
    // Central and Eastern Europe.
    'csob.cz', 'kb.cz', 'csas.cz', 'moneta.cz', 'fio.cz', 'airbank.cz', 'rb.cz', 'mbank.cz',
    'mbank.pl', 'pkobp.pl', 'ipko.pl', 'santander.pl', 'ing.pl', 'pekao.com.pl', 'otpbank.hu',
    // Israel.
    'bankhapoalim.co.il', 'leumi.co.il', 'discountbank.co.il', 'mizrahi-tefahot.co.il',
    'fibi.co.il', 'bank-yahav.co.il', 'max.co.il', 'cal-online.co.il', 'isracard.co.il',
    // Canada, Australia, New Zealand, India, Brazil.
    'rbc.com', 'rbcroyalbank.com', 'scotiabank.com', 'bmo.com', 'cibc.com',
    'tangerine.ca', 'commbank.com.au', 'westpac.com.au', 'anz.com', 'anz.com.au', 'nab.com.au',
    'asb.co.nz', 'kiwibank.co.nz', 'onlinesbi.sbi', 'hdfcbank.com', 'icicibank.com',
    'axisbank.com', 'itau.com.br', 'bradesco.com.br', 'bb.com.br', 'nubank.com.br', 'caixa.gov.br',
    // Anything that names itself as online banking.
    'banking.*', 'onlinebanking.*', 'netbank.*', 'ebanking.*',
  ],

  health: [
    'mychart.com', 'mychart.org', 'zocdoc.com', 'doctolib.de', 'doctolib.fr', 'doctolib.it',
    'jameda.de', 'patient.*', 'patientportal.*', 'my.nhs.uk', 'nhsapp.service.nhs.uk',
    'patientaccess.com', 'myhealth.va.gov', 'healow.com', 'followmyhealth.com',
    'athenahealth.com', 'kp.org', 'healthy.kaiserpermanente.org', 'onemedical.com',
    'teladoc.com', 'amwell.com', 'mdlive.com', 'goodrx.com', 'cvs.com', 'walgreens.com',
    'labcorp.com', 'questdiagnostics.com', 'myquest.questdiagnostics.com', 'betterhelp.com',
    'talkspace.com', 'clalit.co.il', 'maccabi4u.co.il', 'meuhedet.co.il', 'leumit.co.il',
    'tk.de', 'aok.de', 'barmer.de', 'dak.de', 'vzp.cz', 'ameli.fr', 'mijngezondheid.net',
    'mychart.*', 'healthvault.*',
  ],

  adult: [
    // Whole top-level domains set aside for adult content.
    '*.xxx', '*.adult', '*.porn', '*.sex', '*.sexy',
    // The most visited adult sites. Not complete, and cannot be.
    'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'xhamster.desi', 'redtube.com',
    'youporn.com', 'tube8.com', 'spankbang.com', 'eporner.com', 'onlyfans.com', 'fansly.com',
    'chaturbate.com', 'stripchat.com', 'bongacams.com', 'livejasmin.com', 'cam4.com',
    'myfreecams.com', 'camsoda.com', 'brazzers.com', 'realitykings.com', 'bangbros.com',
    'motherless.com', 'rule34.xxx', 'e-hentai.org', 'nhentai.net', 'hentaihaven.xxx',
    'literotica.com', 'fetlife.com', 'adultfriendfinder.com', 'manyvids.com', 'clips4sale.com',
    'beeg.com', 'txxx.com', 'hqporner.com', 'porntrex.com', 'tnaflix.com', 'thumbzilla.com',
    'youjizz.com', 'porn.com', 'sex.com', 'erome.com', 'fapello.com', 'reddit.com/r/nsfw/*',
  ],

  // Who somebody is looking for, and what they said to them, is among the
  // most personal things a browser shows, and the app they use says a good
  // deal on its own.
  dating: [
    'tinder.com', 'bumble.com', 'hinge.co', 'okcupid.com', 'match.com', 'pof.com',
    'plentyoffish.com', 'eharmony.com', 'eharmony.co.uk', 'grindr.com', 'feeld.co',
    'badoo.com', 'zoosk.com', 'coffeemeetsbagel.com', 'happn.com', 'hily.com', 'weareher.com',
    'scruff.com', 'hornet.com', 'taimi.com', 'jdate.com', 'christianmingle.com',
    'elitesingles.com', 'seeking.com', 'ashleymadison.com', 'lovoo.com', 'parship.de',
    'parship.com', 'elitepartner.de', 'meetic.fr', 'meetic.com', 'lexa.nl', 'lexa.de',
    'jiayuan.com', 'dating.com',
  ],

  government: [
    // Whole government domains, by country.
    'gov', 'mil', 'gov.uk', 'gov.il', 'gov.au', 'gov.in', 'gov.br', 'gov.za', 'gov.ie',
    'gov.pl', 'gov.cz', 'gov.it', 'gov.pt', 'gov.gr', 'gov.sg', 'gov.hk', 'gov.cn', 'gov.tr',
    'gov.ua', 'gov.ph', 'gov.my', 'gov.ng', 'go.jp', 'go.kr', 'gc.ca', 'canada.ca', 'govt.nz',
    'gouv.fr', 'gob.es', 'gob.mx', 'gob.ar', 'gv.at', 'admin.ch', 'bund.de', 'overheid.nl',
    'belgium.be', 'fgov.be', 'europa.eu',
    // Tax, identity and benefits portals that live on other domains.
    'mojedatovaschranka.cz', 'identita.gov.cz', 'elster.de', 'id.me', 'login.gov',
    'digid.nl', 'mijn.overheid.nl', 'belastingdienst.nl', 'impots.gouv.fr', 'ameli.fr',
    'franceconnect.gouv.fr', 'agenciatributaria.gob.es', 'agenziaentrate.gov.it', 'inps.it',
    'myaccount.ird.govt.nz', 'my.gov.au', 'ssa.gov', 'irs.gov', 'hmrc.gov.uk', 'tax.service.gov.uk',
  ],

  intranet: [
    '@private-network', 'localhost', '*.local', '*.internal', '*.lan', '*.corp', '*.intranet',
    '*.home', 'home.arpa', 'intranet.*',
    // Routers that answer on a name of their own rather than an address.
    'fritz.box', 'speedport.ip', 'routerlogin.net', 'routerlogin.com', 'tplinkwifi.net',
    'tplinklogin.net', 'router.asus.com', 'myrouter.local', 'mywifiext.net', 'hitronhub.home',
  ],

  workTools: [
    'docs.google.com', 'drive.google.com', 'sheets.google.com', 'slides.google.com',
    'calendar.google.com', 'admin.google.com', 'sharepoint.com', 'onedrive.live.com',
    'office.com', 'microsoft365.com', 'outlook.cloud.microsoft', 'atlassian.net',
    'atlassian.com/wiki/*', 'notion.so', 'notion.site', 'app.asana.com', 'monday.com',
    'app.clickup.com', 'linear.app', 'trello.com', 'airtable.com', 'miro.com', 'figma.com',
    'app.hubspot.com', 'lightning.force.com', 'my.salesforce.com', 'salesforce.com/one/*',
    'zendesk.com', 'freshdesk.com', 'intercom.com/a/*', 'app.intercom.com', 'workday.com',
    'myworkday.com', 'bamboohr.com', 'personio.de', 'personio.com', 'rippling.com',
    'gusto.com', 'app.gusto.com', 'adp.com', 'dropbox.com/home/*', 'box.com', 'app.box.com',
    'quip.com', 'coda.io', 'app.pipedrive.com', 'console.aws.amazon.com', 'portal.azure.com',
    'console.cloud.google.com', 'dash.cloudflare.com', 'app.datadoghq.com', 'vercel.com/dashboard/*',
  ],

  // Search results are a list of other pages, not something anybody reads,
  // and a history of them is a history of every search typed.
  searchResults: [
    'google.*/search', 'bing.com/search', 'duckduckgo.com', 'html.duckduckgo.com',
    'search.brave.com', 'ecosia.org/search', 'startpage.com/sp/search', 'startpage.com/do/search',
    'search.yahoo.com', 'yahoo.co.jp/search', 'yandex.*/search*', 'baidu.com/s', 'qwant.com',
    'kagi.com/search', 'search.aol.com', 'you.com/search', 'perplexity.ai/search/*',
    'search.seznam.cz', 'search.naver.com', 'google.*/webhp', 'google.*/imgres',
    'ask.com/web', 'mojeek.com/search', 'presearch.com/search', 'metager.org/meta/*',
  ],
};

// Shown in setup and settings. Kept beside the lists so a bundle can never
// be added without a human readable description of what it covers.
export const PRESET_LABELS = {
  webmail: { title: 'Webmail', example: 'Gmail, Outlook, Proton' },
  messaging: { title: 'Messaging', example: 'WhatsApp, Slack, Messenger' },
  aiChats: { title: 'AI chats', example: 'ChatGPT, Claude, Gemini' },
  accounts: { title: 'Accounts and passwords', example: 'password managers, account settings' },
  banking: { title: 'Banking and payments', example: 'PayPal, major banks' },
  health: { title: 'Health and medical', example: 'patient portals, pharmacies' },
  adult: { title: 'Adult sites', example: 'the best known ones' },
  dating: { title: 'Dating', example: 'Tinder, Bumble, Hinge, Grindr' },
  government: { title: 'Government and ID portals', example: '.gov, tax, ID login' },
  intranet: { title: 'Local network', example: 'localhost, 192.168.x.x' },
  workTools: { title: 'Work tools', example: 'Google Docs, Jira, Notion' },
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
