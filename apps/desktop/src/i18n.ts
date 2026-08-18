/**
 * Minimal i18n scaffold (UI-8). A single `t()` lookup over a flat string catalog keyed by dotted ids,
 * with `{param}` interpolation. English is the only bundled locale today; the shape is ready for
 * additional locales + a language switch without touching call sites. Intentionally dependency-free.
 */

type Catalog = Record<string, string>;

const en: Catalog = {
  'app.name': 'Lobster Browser',
  'nav.profiles': 'Profiles',
  'nav.proxies': 'Proxies',
  'nav.templates': 'Templates',
  'action.createProfile': 'Create Profile',
  'action.launch': 'Launch',
  'action.stop': 'Stop',
  'profiles.empty.title': 'No profiles yet',  'profiles.count': '{count} profiles',
  'palette.placeholder': 'Search profiles, actions, pages…',
};

const locales: Record<string, Catalog> = { en };
let current = 'en';

export function setLocale(locale: string): void {
  if (locales[locale]) current = locale;
}

export function availableLocales(): string[] {
  return Object.keys(locales);
}

/** Translate a key with optional `{param}` interpolation; falls back to the key if missing. */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = locales[current] ?? en;
  let str = dict[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return str;
}
