/**
 * Which cookie domains a SITE's session actually lives on.
 *
 * The owner asked Lobee to "remove all cookies of outlook.com" and Outlook stayed signed in. It was
 * not a driver bug: `clear_cookies outlook.com` deleted every cookie for outlook.com and its
 * subdomains, exactly as asked — and Microsoft's session is not there. It is on login.live.com,
 * login.microsoftonline.com and office.com, with outlook.com holding little more than preferences.
 * Every large identity provider is like this: the site you see and the domains that keep you signed
 * in are different registrable domains, so a literal-domain delete cannot log anyone out of anything
 * that matters.
 *
 * This table maps a site to the registrable domains that make up its session footprint. It is a
 * curated floor, not a ceiling: `resolveSiteFamily` also folds in every domain in the live cookie
 * store that shares the site's registrable domain, so a family the table does not know still gets
 * its own subdomains. Unknown sites therefore behave exactly as before — they just get no relatives.
 */

const FAMILIES: ReadonlyArray<ReadonlyArray<string>> = [
  [
    'outlook.com',
    'live.com',
    'hotmail.com',
    'microsoftonline.com',
    'microsoft.com',
    'office.com',
    'office365.com',
    'msn.com',
    'onedrive.com',
    'sharepoint.com',
    'azure.com',
    'msauth.net',
    'msftauth.net',
  ],
  ['google.com', 'gmail.com', 'youtube.com', 'googleusercontent.com', 'gstatic.com', 'ggpht.com'],
  ['facebook.com', 'fb.com', 'instagram.com', 'messenger.com', 'whatsapp.com', 'fbcdn.net'],
  ['apple.com', 'icloud.com'],
  ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.ca', 'amazon.fr', 'amazon.it', 'amazon.es'],
  ['linkedin.com', 'licdn.com'],
  ['x.com', 'twitter.com', 'twimg.com'],
  ['yahoo.com', 'aol.com', 'yimg.com'],
  ['github.com', 'githubusercontent.com'],
  ['reddit.com', 'redd.it', 'redditstatic.com'],
  ['ebay.com', 'ebaystatic.com'],
  ['paypal.com', 'paypalobjects.com'],
];

/** Registrable-ish domain: the last two labels, or three when the second-level label is short (co.uk). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^\./, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const second = labels[labels.length - 2]!;
  const take = second.length <= 3 && labels.length >= 3 ? 3 : 2;
  return labels.slice(-take).join('.');
}

/**
 * The set of registrable domains that make up `site`'s session, given the domains currently in the
 * cookie store. Always includes the site itself. Sorted so output is stable.
 */
export function resolveSiteFamily(site: string, storeDomains: Iterable<string>): string[] {
  const seed = registrableDomain(site);
  const family = new Set<string>([seed]);
  for (const group of FAMILIES) {
    if (group.includes(seed)) for (const member of group) family.add(member);
  }
  for (const raw of storeDomains) {
    const reg = registrableDomain(raw);
    if (family.has(reg)) family.add(reg);
  }
  return [...family].sort();
}

/** True when a cookie/store domain belongs to one of the family's registrable domains. */
export function domainInFamily(domain: string, family: ReadonlyArray<string>): boolean {
  const reg = registrableDomain(domain);
  return family.includes(reg);
}

/** Product names people type instead of a domain, mapped to the site the session belongs to. */
const SITE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(outlook|hotmail|office ?365|onedrive|microsoft account)\b/, 'outlook.com'],
  [/\b(gmail|google|youtube)\b/, 'google.com'],
  [/\b(facebook|instagram|messenger|whatsapp)\b/, 'facebook.com'],
  [/\b(icloud|apple id)\b/, 'apple.com'],
  [/\bamazon\b/, 'amazon.com'],
  [/\blinkedin\b/, 'linkedin.com'],
  [/\b(twitter|x\.com)\b/, 'x.com'],
  [/\b(yahoo|aol)\b/, 'yahoo.com'],
  [/\bgithub\b/, 'github.com'],
  [/\breddit\b/, 'reddit.com'],
  [/\bebay\b/, 'ebay.com'],
  [/\bpaypal\b/, 'paypal.com'],
];

/**
 * The site a request names, if it names one: a domain-looking token first ("outlook.com",
 * "mail.example.co.uk"), then a known product name ("my Outlook", "gmail"). Undefined when the
 * request is genuinely site-less ("clear all cookies", "log me out everywhere") — that is the only
 * phrasing under which a wipe-all is what the user meant.
 */
export function siteNamedIn(text: string): string | undefined {
  const lower = text.toLowerCase();
  const domain = lower.match(
    /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|me|de|uk|fr|it|es|ca|au|jp|ru|nl|se|ch|at|dev|app|ai|live)\b/,
  );
  if (domain) return registrableDomain(domain[0]);
  for (const [pattern, site] of SITE_ALIASES) if (pattern.test(lower)) return site;
  return undefined;
}
