
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseJson, parseNetscape } from '@lobster/cookies';
import { normalizeDeviceMemory } from '@lobster/fingerprint';

import type {
  CookieImportDraft,
  CookieImportMode,
  BrowserExtensionRef,
  CreateProfileInput,
  CreateStoredProxyInput,
  Profile,
  ProfileOsTarget,
  ProfileTemplate,
  ProxyConfig,
  ProxyTestResult,
  ProxyType,
  StoredProxy,
} from '@lobster/shared-types';

import { isDesktopRuntime, type ProfilePatch } from '../../api/tauri';
import appIcon from '../../assets/brand/icon.png';
import { OS_OPTIONS, OS_VERSION_OPTIONS } from './options';
import {
  LOCALE_OPTIONS,
  LOCATION_OPTIONS,
  TIMEZONE_OPTIONS,
  expandLocaleToLanguages,
  primaryLocaleOf,
} from './geoLocaleData';
import { OsIcon } from './OsIcon';
import {
  ANDROID_DEVICE_TYPE_OPTIONS,
  CPU_CORE_OPTIONS,
  DEVICE_MEMORY_OPTIONS,
  PERSONA_MODE_OPTIONS,
  WEBRTC_MODE_OPTIONS,
  androidModelsForSelection,
  defaultSelectedFontsForTarget,
  defaultUserAgent,
  findAndroidCatalogEntry,
  parseScreenOption,
  rendererPresetById,
  rendererPresetsForTarget,
  screenOptionsForTarget,
  type AndroidDeviceType,
  type PersonaMode,
  type WebRtcUiMode,
} from './fingerprintCatalog';
import {
  changeDraftOs,
  chromeWebStoreExtensionId,
  createProfileDraft,
  hydrateProfileDraft,
  hydrateTemplateDraft,
  serializeProfileDraft,
  validateProfileDraft,
  type ProfileDraft,
} from './profileDraft';
import { Icon } from '../../ui/Icon';

interface NewProfileFormProps {
  profile?: Profile;
  onCreate?: (input: CreateProfileInput, options?: { password?: string }) => Promise<void>;
  onSave?: (patch: ProfilePatch, options?: { password?: string | null }) => Promise<void>;
  onCancel: () => void;
  onCreateProxy?: (input: CreateStoredProxyInput) => Promise<StoredProxy>;
  onTestProxy?: (config: ProxyConfig) => Promise<ProxyTestResult>;
  proxies?: StoredProxy[];
  templates?: ProfileTemplate[];
  loadFontFamilies?: (os: ProfileOsTarget) => Promise<string[]>;
}

type WizardStep = 'general' | 'fingerprint' | 'cookies' | 'security' | 'extensions';

type FormState = ProfileDraft;

interface CustomProxyDraft {
  title: string;
  type: ProxyType;
  host: string;
  port: string;
  login: string;
  password: string;
}

interface ValidationIssue {
  step: WizardStep;
  message: string;
}

const STEPS: ReadonlyArray<{ key: WizardStep; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'fingerprint', label: 'Fingerprint' },
  { key: 'cookies', label: 'Cookies' },
  { key: 'security', label: 'Security' },
  { key: 'extensions', label: 'Extensions' },
];

const CUSTOM_PROXY_VALUE = '__custom__';
const MAX_COOKIE_FILE_BYTES = 5 * 1024 * 1024;

function isValidLanguageTag(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isNonNegativeInteger(value: string): boolean {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 0;
}

const initialState: FormState = {
  ...createProfileDraft(),
  androidDeviceModel: androidModelsForSelection('mobile', OS_VERSION_OPTIONS.android[0])[0] ?? '',
};

const emptyCustomProxy: CustomProxyDraft = {
  title: '',
  type: 'socks5',
  host: '',
  port: '',
  login: '',
  password: '',
};

function numberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function parseCookieDraft(
  rawText: string,
  fileName: string,
): Partial<Pick<CookieImportDraft, 'parsedCount' | 'errors'>> {
  const text = rawText.trim();
  if (!text) return {};
  try {
    const cookies =
      fileName.toLowerCase().endsWith('.json') || text.startsWith('[')
        ? parseJson(text)
        : parseNetscape(text);
    return {
      parsedCount: cookies.length,
      ...(cookies.length === 0 ? { errors: [{ message: 'No cookies detected.' }] } : {}),
    };
  } catch (e: unknown) {
    return {
      parsedCount: 0,
      errors: [{ message: e instanceof Error ? e.message : String(e) }],
    };
  }
}

function portNumber(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) return null;
  return value;
}

function customProxyConfig(draft: CustomProxyDraft, id: string): ProxyConfig | null {
  const port = portNumber(draft.port.trim());
  const host = draft.host.trim();
  if (!host || port === null) return null;
  const config: ProxyConfig = {
    id,
    type: draft.type,
    host,
    port,
    ...(draft.title.trim() ? { label: draft.title.trim() } : {}),
  };
  const username = draft.login.trim();
  if (username) config.username = username;
  if (draft.password) config.password = draft.password;
  return config;
}

function validationIssues(
  form: FormState,
  customProxy: CustomProxyDraft,
  selectedProxy: StoredProxy | undefined,
  selectedTemplate: ProfileTemplate | undefined,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (step: WizardStep, message: string): void => {
    issues.push({ step, message });
  };

  const name = form.name.trim();
  if (!name) add('general', 'Enter a profile name.');
  else if (name.length > 120) add('general', 'Profile name must be 120 characters or fewer.');
  if (form.description.length > 2_000) {
    add('general', 'Description must be 2,000 characters or fewer.');
  }
  if (form.templateId && !selectedTemplate) {
    add('general', 'The selected template is no longer available.');
  }
  if (form.proxyId === CUSTOM_PROXY_VALUE) {
    if (!customProxy.title.trim()) add('general', 'Enter a title for the custom proxy.');
    if (!customProxy.host.trim()) add('general', 'Enter the custom proxy host.');
    else if (/\s|:\/\/|\//.test(customProxy.host.trim())) {
      add('general', 'Enter the proxy host without a scheme, path, or spaces.');
    }
    if (portNumber(customProxy.port.trim()) === null) {
      add('general', 'Proxy port must be a whole number from 1 to 65535.');
    }
    if (customProxy.password && !customProxy.login.trim()) {
      add('general', 'Enter a proxy login when a proxy password is set.');
    }
  } else if (form.proxyId && !selectedProxy) {
    add('general', 'The selected proxy is no longer available.');
  }

  if (form.os === 'android') {
    if (!findAndroidCatalogEntry(form.androidDeviceType, form.androidDeviceModel)) {
      add('fingerprint', 'Choose a verified Android device model from the list.');
    }
  } else {
    if (!parseScreenOption(form.screenResolution)) {
      add('fingerprint', 'Choose a valid screen resolution.');
    }
    if (form.fonts.mode === 'manual' && form.fonts.selected.length === 0) {
      add('fingerprint', 'Select at least one OS-compatible font.');
    }
    if (
      form.rendererPresetId !== 'host' &&
      form.rendererPresetId !== 'normalized_host' &&
      !rendererPresetById(form.os, form.rendererPresetId)
    ) {
      add('fingerprint', 'Choose the calibrated host renderer or a sourced renderer preset.');
    }
    if (!CPU_CORE_OPTIONS.includes(Number(form.cpuCores) as (typeof CPU_CORE_OPTIONS)[number])) {
      add('fingerprint', 'Choose a verified CPU core count.');
    }
    if (
      !DEVICE_MEMORY_OPTIONS.includes(
        Number(form.ramSize) as (typeof DEVICE_MEMORY_OPTIONS)[number],
      )
    ) {
      add('fingerprint', 'Choose a Lobium-compatible reported memory value.');
    }
  }

  if (form.languageMode === 'manual') {
    const languages = form.languages
      .split(',')
      .map((language) => language.trim())
      .filter(Boolean);
    if (languages.length === 0) add('fingerprint', 'Enter at least one language tag.');
    else if (languages.some((language) => !isValidLanguageTag(language))) {
      add('fingerprint', 'Use valid BCP-47 language tags, for example en-US, en.');
    }
  }
  if (form.timezoneMode === 'manual' && !isValidTimezone(form.timezone.trim())) {
    add('fingerprint', 'Enter a valid IANA timezone, for example America/New_York.');
  }
  if (form.geolocationMode === 'manual') {
    const latitude = numberOrUndefined(form.geolocationLat);
    const longitude = numberOrUndefined(form.geolocationLng);
    const accuracy = numberOrUndefined(form.geolocationAccuracy);
    if (latitude === undefined || latitude < -90 || latitude > 90) {
      add('fingerprint', 'Latitude must be a number from -90 to 90.');
    }
    if (longitude === undefined || longitude < -180 || longitude > 180) {
      add('fingerprint', 'Longitude must be a number from -180 to 180.');
    }
    if (accuracy === undefined || accuracy <= 0) {
      add('fingerprint', 'Geolocation accuracy must be greater than zero.');
    }
  }
  for (const [value, label] of [
    [form.mediaCameras, 'Camera'],
    [form.mediaMicrophones, 'Microphone'],
    [form.mediaSpeakers, 'Speaker'],
  ] as const) {
    if (!isNonNegativeInteger(value)) {
      add('fingerprint', `${label} count must be a non-negative whole number.`);
    }
  }

  if (form.cookiesMode === 'replace' && !form.cookiesText.trim()) {
    add('cookies', 'Add cookies before choosing Replace cookie jar.');
  }
  if (form.cookiesMode !== 'empty' && form.cookiesErrors?.length) {
    add('cookies', 'Fix the cookie import errors before creating the profile.');
  }

  if (form.password !== form.passwordConfirm) {
    add('security', 'Password confirmation does not match.');
  }
  if (form.passwordConfirm && !form.password) {
    add('security', 'Enter a password before confirming it.');
  }

  return issues;
}

function FontMultiSelect({
  options,
  selected,
  onChange,
}: {
  options: readonly string[];
  selected: string[];
  onChange: (next: string[]) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((font) => font.toLowerCase().includes(q));
  }, [options, query]);

  function toggle(font: string): void {
    if (selectedSet.has(font)) onChange(selected.filter((item) => item !== font));
    else onChange([...selected, font]);
  }

  return (
    <details className="font-multiselect">
      <summary className="font-multiselect__summary">
        <span>{selected.length.toLocaleString()} OS-compatible fonts selected</span>
        <span className="font-multiselect__summary-action">Review</span>
      </summary>
      <div className="font-multiselect__content">
        <div className="font-multiselect__toolbar">
          <input
            className="input"
            type="search"
            value={query}
            aria-label="Search available fonts"
            placeholder="Search fonts"
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="font-multiselect__tag">{selected.length} selected</span>
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            onClick={() => onChange([...options])}
          >
            Select all
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            onClick={() => onChange([])}
          >
            Clear
          </button>
        </div>
        <div className="font-multiselect__list" role="listbox" aria-multiselectable="true">
          {filtered.slice(0, 800).map((font) => {
            const active = selectedSet.has(font);
            return (
              <button
                key={font}
                type="button"
                role="option"
                aria-selected={active}
                className={active ? 'font-chip font-chip--selected' : 'font-chip'}
                onClick={() => toggle(font)}
              >
                {font}
              </button>
            );
          })}
        </div>
      </div>
    </details>
  );
}

/**
 * Single-select searchable combobox for large option lists (thousands of entries).
 *
 * Replaces a plain `<input list>` + `<datalist>`: WebKitGTK (the Tauri Linux webview) renders its
 * native datalist popup with only a handful of suggestions regardless of how many `<option>`s are
 * present, so a 15k-entry device catalog effectively showed as "one suggestion." This component owns
 * its own filtered listbox, so the full catalog is genuinely browsable/searchable everywhere the app
 * runs.
 */
function SearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  invalid,
  ariaLabel,
}: {
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  invalid?: boolean;
  ariaLabel?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const [scrollTop, setScrollTop] = useState(0);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((option) => option.toLowerCase().includes(q)) : options;
  }, [options, query]);

  // Rendering the complete phone catalog can mean 15k+ rows. Keep every option reachable while
  // mounting only the rows around the current scroll position.
  const optionHeight = 36;
  const overscan = 6;
  const firstVisible = Math.max(0, Math.floor(scrollTop / optionHeight) - overscan);
  const lastVisible = Math.min(
    filtered.length,
    firstVisible + Math.ceil(260 / optionHeight) + overscan * 2,
  );
  const visibleOptions = filtered.slice(firstVisible, lastVisible);

  function select(option: string): void {
    onChange(option);
    setQuery(option);
    setOpen(false);
  }

  return (
    <div className="combobox">
      <input
        className="input"
        value={query}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        onFocus={() => {
          // A selected value is not a search filter. Opening the picker must expose the catalog,
          // rather than filtering it down to the one device that is already selected.
          setQuery('');
          setScrollTop(0);
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setScrollTop(0);
          setOpen(true);
        }}
        onBlur={() => {
          window.setTimeout(() => {
            setOpen(false);
            setQuery(value);
          }, 120);
        }}
      />
      {open && (
        <div
          className="combobox__list"
          role="listbox"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          {filtered.length === 0 ? (
            <div className="combobox__empty">No matches</div>
          ) : (
            <div className="combobox__viewport" style={{ height: filtered.length * optionHeight }}>
              {visibleOptions.map((option, offset) => (
                <button
                  key={option}
                  type="button"
                  role="option"
                  aria-selected={option === value}
                  className={
                    option === value
                      ? 'combobox__option combobox__option--active'
                      : 'combobox__option'
                  }
                  style={{ top: (firstVisible + offset) * optionHeight }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    select(option);
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * OS picker rendered as a custom dropdown so the platform glyph shows INSIDE the field and on EVERY
 * option (a native <select> cannot render per-option SVG icons). macOS Intel/ARM carry their i/a badge.
 */
function OsSelect({
  value,
  options,
  onChange,
}: {
  value: ProfileOsTarget;
  options: ReadonlyArray<{ value: ProfileOsTarget; label: string }>;
  onChange: (next: ProfileOsTarget) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="os-select" ref={rootRef}>
      <button
        type="button"
        className="input os-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Operating system"
        onClick={() => setOpen((current) => !current)}
      >
        <OsIcon os={value} size={18} className="os-select__glyph" />
        <span className="os-select__value">{selected?.label ?? value}</span>
        <Icon name="ChevronDownIcon" className="os-select__chevron" aria-hidden />
      </button>
      {open ? (
        <div className="os-select__list" role="listbox">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={
                option.value === value
                  ? 'os-select__option os-select__option--active'
                  : 'os-select__option'
              }
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <OsIcon os={option.value} size={18} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function NewProfileForm({
  profile,
  onCreate,
  onSave,
  onCancel,
  onCreateProxy,
  onTestProxy,
  proxies = [],
  templates = [],
  loadFontFamilies,
}: NewProfileFormProps): JSX.Element {
  const [step, setStep] = useState<WizardStep>('general');
  const [form, setForm] = useState<FormState>(() => {
    const hydrated = profile ? hydrateProfileDraft(profile) : initialState;
    const initial =
      profile?.proxy && !profile.proxyId ? { ...hydrated, proxyId: CUSTOM_PROXY_VALUE } : hydrated;
    return initial;
  });
  const [customProxy, setCustomProxy] = useState<CustomProxyDraft>(() =>
    profile?.proxy && !profile.proxyId
      ? {
          title: profile.proxy.label ?? '',
          type: profile.proxy.type,
          host: profile.proxy.host,
          port: String(profile.proxy.port),
          login: profile.proxy.username ?? '',
          password: profile.proxy.password ?? '',
        }
      : emptyCustomProxy,
  );
  const [proxyChecking, setProxyChecking] = useState(false);
  const [proxyTest, setProxyTest] = useState<ProxyTestResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fontCatalogError, setFontCatalogError] = useState<string | null>(null);
  // Distinct from an error: no pack is installed. Windows does not need one - font isolation there
  // is native, and the pack only adds families the host lacks - so this is a notice, not a blocker.
  const [fontPackAbsent, setFontPackAbsent] = useState(false);
  const [fontCatalogLoading, setFontCatalogLoading] = useState(Boolean(loadFontFamilies));
  const [extensionSource, setExtensionSource] =
    useState<BrowserExtensionRef['source']>('chrome_web_store');
  const [extensionValue, setExtensionValue] = useState('');
  const [extensionInputError, setExtensionInputError] = useState<string | null>(null);

  useEffect(() => {
    if (!loadFontFamilies || form.os === 'android') return;
    let current = true;
    setFontCatalogLoading(true);
    setFontCatalogError(null);
    setFontPackAbsent(false);
    void loadFontFamilies(form.os)
      .then((available) => {
        if (!current) return;
        // The manifest lists physical open-font faces. The full verified OS catalog remains the
        // selectable/observable persona; the launcher aliases those names onto this private pack.
        if (available.length === 0 && isDesktopRuntime()) {
          throw new Error('the installed font pack contains no physical families');
        }
        setFontCatalogLoading(false);
      })
      .catch((cause: unknown) => {
        if (!current) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        // FONT_PACK_ABSENT means no pack is installed, which is not the same as a broken one and
        // must not block creating a profile. On Windows the engine filters font lookups against the
        // persona list natively, so the profile is still font-isolated; what a pack would add is
        // families this host does not have installed. The persona still advertises the full OS
        // catalog either way, so the picker below is correct with or without a pack.
        //
        // Every other failure - unreadable manifest, wrong version, unsafe path, physical families
        // missing - means the pack cannot back what the persona claims, and still blocks.
        if (message.includes('FONT_PACK_ABSENT')) {
          setFontPackAbsent(true);
        } else {
          setFontCatalogError(message);
        }
        setFontCatalogLoading(false);
      });
    return () => {
      current = false;
    };
  }, [form.os, loadFontFamilies]);

  const versionOptions = OS_VERSION_OPTIONS[form.os];
  const screenOptions = screenOptionsForTarget(form.os);
  const rendererOptions = rendererPresetsForTarget(form.os);
  const androidModels = androidModelsForSelection(form.androidDeviceType, form.osVersion);
  const selectedProxy = proxies.find((proxy) => proxy.id === form.proxyId);
  const selectedTemplate = templates.find((template) => template.id === form.templateId);
  const isAndroid = form.os === 'android';
  const legacyAndroid = false;
  const editing = Boolean(profile);
  const isCustomProxy = form.proxyId === CUSTOM_PROXY_VALUE;
  const userAgent = defaultUserAgent(form.os, form.androidDeviceType);
  const issues = useMemo(() => {
    const draftIssues = validateProfileDraft(form);
    return [
      ...draftIssues,
      ...validationIssues(form, customProxy, selectedProxy, selectedTemplate).filter(
        (issue) =>
          !draftIssues.some(
            (draftIssue) => draftIssue.step === issue.step && draftIssue.message === issue.message,
          ),
      ),
    ];
  }, [form, customProxy, selectedProxy, selectedTemplate, legacyAndroid]);
  const currentStepIssues = showValidation ? issues.filter((issue) => issue.step === step) : [];
  const canSubmit = !submitting && !fontCatalogLoading && fontCatalogError === null;

  const warnings = useMemo(() => {
    const items: string[] = [];
    if (form.proxyId && !isCustomProxy && !selectedProxy) {
      items.push('Selected proxy is no longer available.');
    }
    if (form.cookiesMode === 'empty') {
      items.push('Cookie jar will start empty for this profile.');
    } else if (form.cookiesText.trim()) {
      items.push(
        form.cookiesMode === 'replace'
          ? 'Imported cookies will replace the profile cookie jar at launch.'
          : 'Imported cookies will merge into the profile cookie jar at launch.',
      );
    }
    if (form.extensions.some((extension) => extension.enabled)) {
      items.push('Enabled extensions are verified and installed before Lobium starts.');
    }
    return items;
  }, [form, selectedProxy, isCustomProxy]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }

  function setCustom<K extends keyof CustomProxyDraft>(key: K, value: CustomProxyDraft[K]): void {
    setCustomProxy((prev) => ({ ...prev, [key]: value }));
    setProxyTest(null);
    setError(null);
  }

  function setOs(os: ProfileOsTarget): void {
    setForm((prev) => {
      const next = changeDraftOs(prev, os);
      const nextModels =
        os === 'android' ? androidModelsForSelection(prev.androidDeviceType, next.osVersion) : [];
      return {
        ...next,
        androidDeviceModel: nextModels[0] ?? prev.androidDeviceModel,
      };
    });
    setError(null);
  }

  function addExtension(): void {
    const value = extensionValue.trim();
    if (!value) {
      setExtensionInputError('Enter an extension ID, official store URL, or absolute local path.');
      return;
    }
    let extension: BrowserExtensionRef;
    if (extensionSource === 'chrome_web_store') {
      const id = chromeWebStoreExtensionId(value);
      if (!id) {
        setExtensionInputError('Enter a valid Chrome Web Store ID or official HTTPS detail URL.');
        return;
      }
      if (
        form.extensions.some(
          (item) =>
            item.source === 'chrome_web_store' &&
            chromeWebStoreExtensionId(item.id ?? item.url ?? '') === id,
        )
      ) {
        setExtensionInputError('That Chrome Web Store extension is already configured.');
        return;
      }
      extension = {
        source: 'chrome_web_store',
        enabled: true,
        id,
        ...(value.startsWith('https://') ? { url: value } : {}),
        installState: 'pending',
      };
    } else {
      const absolute =
        value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
      if (!absolute) {
        setExtensionInputError('Local unpacked extension paths must be absolute.');
        return;
      }
      if (
        form.extensions.some((item) => item.source === 'unpacked' && item.path?.trim() === value)
      ) {
        setExtensionInputError('That local unpacked extension is already configured.');
        return;
      }
      extension = {
        source: 'unpacked',
        enabled: true,
        path: value,
        name: value.split(/[\\/]/).filter(Boolean).at(-1) || 'Local extension',
        installState: 'pending',
      };
    }
    setForm((previous) => ({
      ...previous,
      extensions: [...previous.extensions, extension],
    }));
    setExtensionValue('');
    setExtensionInputError(null);
  }

  function setAndroidDeviceType(androidDeviceType: AndroidDeviceType): void {
    const models = androidModelsForSelection(androidDeviceType, form.osVersion);
    setForm((prev) => ({
      ...prev,
      androidDeviceType,
      androidDeviceModel: models[0] ?? prev.androidDeviceModel,
    }));
    setError(null);
  }

  function setOsVersion(osVersion: string): void {
    setForm((prev) => {
      if (prev.os !== 'android') return { ...prev, osVersion };
      const models = androidModelsForSelection(prev.androidDeviceType, osVersion);
      const keep = models.includes(prev.androidDeviceModel);
      return {
        ...prev,
        osVersion,
        androidDeviceModel: keep ? prev.androidDeviceModel : (models[0] ?? prev.androidDeviceModel),
      };
    });
    setError(null);
  }

  function applyTemplate(templateId: string): void {
    const template = templates.find((item) => item.id === templateId);
    setError(null);
    setForm((prev) => {
      if (!template) return { ...prev, templateId };
      const hydrated = hydrateTemplateDraft(prev, template);
      const osVersion = template.osVersion ?? OS_VERSION_OPTIONS[template.os][0];
      const screens = screenOptionsForTarget(template.os);
      const overrides = template.fingerprintOverrides;
      const geolocation = overrides?.locale?.geolocation;
      const templateRenderer = overrides?.renderer;
      const rendererPresetId =
        templateRenderer?.mode === 'validated_preset' &&
        rendererPresetById(template.os, templateRenderer.presetId)
          ? templateRenderer.presetId
          : 'host';
      const templateScreen = overrides?.screen;
      const matchingScreen = templateScreen
        ? screens.find((option) => {
            const parsed = parseScreenOption(option);
            return (
              parsed !== undefined &&
              parsed.width === templateScreen.width &&
              parsed.height === templateScreen.height &&
              parsed.devicePixelRatio === (templateScreen.devicePixelRatio ?? 1)
            );
          })
        : undefined;
      const webrtcMode: WebRtcUiMode = !overrides?.webrtc
        ? prev.webrtcMode
        : overrides.webrtc === 'proxy_only'
          ? 'based_ip'
          : overrides.webrtc === 'disable_non_proxied_udp'
            ? 'disable_udp'
            : overrides.webrtc === 'disabled'
              ? 'disabled'
              : 'real';
      return {
        ...hydrated,
        templateId,
        os: template.os,
        osVersion,
        proxyId: template.proxyId ?? prev.proxyId,
        tags: template.tags.length > 0 ? template.tags.join(', ') : prev.tags,
        screenResolution: matchingScreen ?? screens[0] ?? prev.screenResolution,
        fonts: {
          ...hydrated.fonts,
          mode: overrides?.fontsMode ?? hydrated.fonts.mode,
          selected: (overrides?.fonts ?? defaultSelectedFontsForTarget(template.os)).filter(
            (font) => hydrated.fonts.available.includes(font),
          ),
        },
        languageMode:
          overrides?.languageMode ??
          (overrides?.navigator?.languages ? 'manual' : prev.languageMode),
        languages: overrides?.navigator?.languages?.join(', ') ?? prev.languages,
        timezoneMode:
          overrides?.timezoneMode ?? (overrides?.locale?.timezone ? 'manual' : prev.timezoneMode),
        timezone: overrides?.locale?.timezone ?? prev.timezone,
        geolocationMode:
          overrides?.geolocationMode ?? (geolocation ? 'manual' : prev.geolocationMode),
        geolocationLat: geolocation ? String(geolocation.latitude) : prev.geolocationLat,
        geolocationLng: geolocation ? String(geolocation.longitude) : prev.geolocationLng,
        geolocationAccuracy: geolocation ? String(geolocation.accuracy) : prev.geolocationAccuracy,
        cpuCores: overrides?.navigator?.hardwareConcurrency
          ? String(overrides.navigator.hardwareConcurrency)
          : prev.cpuCores,
        ramSize: overrides?.navigator?.deviceMemory
          ? String(normalizeDeviceMemory(overrides.navigator.deviceMemory))
          : prev.ramSize,
        rendererPresetId,
        webrtcMode,
        noiseWebgl: overrides?.hardwareNoise?.webgl ?? prev.noiseWebgl,
        noiseCanvas: overrides?.hardwareNoise?.canvas ?? prev.noiseCanvas,
        noiseAudio: overrides?.hardwareNoise?.audio ?? prev.noiseAudio,
        noiseClientRects: overrides?.hardwareNoise?.clientRects ?? prev.noiseClientRects,
        mediaCameras: String(overrides?.mediaDevices?.cameras ?? prev.mediaCameras),
        mediaMicrophones: String(overrides?.mediaDevices?.microphones ?? prev.mediaMicrophones),
        mediaSpeakers: String(overrides?.mediaDevices?.speakers ?? prev.mediaSpeakers),
        stableDeviceIds: overrides?.mediaDevices?.stableDeviceIds ?? prev.stableDeviceIds,
        androidDeviceType: overrides?.androidDeviceType ?? prev.androidDeviceType,
        androidDeviceModel: overrides?.androidDeviceModel ?? prev.androidDeviceModel,
      };
    });
  }

  function setCookieText(rawText: string, fileName = form.cookiesFileName): void {
    const parsed = parseCookieDraft(rawText, fileName);
    setError(null);
    setForm((prev) => ({
      ...prev,
      cookiesText: rawText,
      cookiesFileName: fileName,
      cookiesParsedCount: parsed.parsedCount,
      cookiesErrors: parsed.errors,
    }));
  }

  async function handleCookieFile(file: File | undefined): Promise<void> {
    if (!file) return;
    if (file.size > MAX_COOKIE_FILE_BYTES) {
      setForm((prev) => ({
        ...prev,
        cookiesText: '',
        cookiesFileName: file.name,
        cookiesParsedCount: 0,
        cookiesErrors: [{ message: 'Cookie file must be 5 MB or smaller.' }],
      }));
      return;
    }
    try {
      const rawText = await file.text();
      setCookieText(rawText, file.name);
    } catch (e: unknown) {
      setForm((prev) => ({
        ...prev,
        cookiesText: '',
        cookiesFileName: file.name,
        cookiesParsedCount: 0,
        cookiesErrors: [{ message: e instanceof Error ? e.message : String(e) }],
      }));
    }
  }

  function buildCustomProxyInput(): CreateStoredProxyInput | null {
    if (!customProxy.title.trim()) return null;
    const config = customProxyConfig(customProxy, `px_${crypto.randomUUID().replaceAll('-', '')}`);
    if (!config) return null;
    return {
      source: 'mine',
      label: customProxy.title.trim(),
      config,
    };
  }

  async function handleTestProxy(): Promise<void> {
    const config = customProxyConfig(customProxy, 'px_profile_draft');
    if (!config || !onTestProxy) return;
    setProxyChecking(true);
    setProxyTest(null);
    try {
      setProxyTest(await onTestProxy(config));
    } catch (e: unknown) {
      setProxyTest({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setProxyChecking(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;

    const latestIssues = [
      ...validateProfileDraft(form),
      ...validationIssues(form, customProxy, selectedProxy, selectedTemplate),
    ];
    if (latestIssues.length > 0) {
      setShowValidation(true);
      setError(latestIssues[0]?.message ?? 'Review the highlighted profile settings.');
      setStep(latestIssues[0]?.step ?? 'general');
      return;
    }

    const serialized = serializeProfileDraft(form, profile);
    const input = serialized.input;

    setSubmitting(true);
    setError(null);
    try {
      if (isCustomProxy) {
        const proxyInput = buildCustomProxyInput();
        if (!proxyInput) {
          setError('Custom proxy needs a title, host, and valid port.');
          setStep('general');
          setSubmitting(false);
          return;
        }
        if (!onCreateProxy) {
          setError('Custom proxy creation is unavailable in this runtime.');
          setSubmitting(false);
          return;
        }
        const createdProxy = await onCreateProxy(proxyInput);
        input.proxyId = createdProxy.id;
      } else if (selectedProxy) {
        input.proxyId = selectedProxy.id;
      }

      if (editing) {
        if (!onSave) throw new Error('Profile editing is unavailable in this runtime.');
        const patch: ProfilePatch = {
          ...input,
          notes: form.description.trim(),
          folder: form.folder.trim(),
          proxyId: input.proxyId ?? '',
          extensions: input.extensions ?? [],
        };
        await onSave(
          patch,
          serialized.password !== undefined ? { password: serialized.password } : undefined,
        );
      } else {
        if (!onCreate) throw new Error('Profile creation is unavailable in this runtime.');
        await onCreate(
          input,
          typeof serialized.password === 'string' ? { password: serialized.password } : undefined,
        );
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <form
      className="wizard modal"
      onSubmit={handleSubmit}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-profile-title"
      noValidate
    >
      <header className="modal-header">
        <h2 id="new-profile-title">{editing ? 'Edit profile' : 'New profile'}</h2>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Close">
          <Icon name="XMarkIcon" aria-hidden />
        </button>
      </header>

      <div className="wizard-steps" role="tablist" aria-label="Profile setup sections">
        {STEPS.map((item) => {
          const issueCount = showValidation
            ? issues.filter((issue) => issue.step === item.key).length
            : 0;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              id={`new-profile-tab-${item.key}`}
              aria-selected={item.key === step}
              aria-controls={`new-profile-panel-${item.key}`}
              className={item.key === step ? 'wizard-step wizard-step--active' : 'wizard-step'}
              onClick={() => setStep(item.key)}
            >
              <span>{item.label}</span>
              {issueCount > 0 ? (
                <span className="wizard-step__issues" aria-label={`${issueCount} issues`}>
                  {issueCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="modal-body wizard-body">
        {step === 'general' ? (
          <section
            className="wizard-section"
            role="tabpanel"
            id="new-profile-panel-general"
            aria-labelledby="new-profile-tab-general"
          >
            <fieldset
              className="field-grid"
              disabled={legacyAndroid}
              style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
            >
              <label className="field field--wide">
                <span className="field__label">Template</span>
                <select
                  className="input"
                  value={form.templateId}
                  onChange={(e) => applyTemplate(e.target.value)}
                >
                  <option value="">No template</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field field--wide">
                <span className="field__label">
                  <span className="required">*</span> Profile name
                </span>
                <div className="profile-name-row">
                  <img className="profile-icon-preview" src={appIcon} alt="" aria-hidden />
                  <input
                    className="input"
                    type="text"
                    value={form.name}
                    maxLength={120}
                    aria-invalid={
                      showValidation &&
                      (form.name.trim().length === 0 || form.name.trim().length > 120)
                    }
                    placeholder="Enter profile name"
                    onChange={(e) => set('name', e.target.value)}
                    autoFocus
                  />
                </div>
              </label>

              <label className="field field--wide">
                <span className="field__label">Description</span>
                <textarea
                  className="input textarea textarea--profile"
                  value={form.description}
                  maxLength={2000}
                  placeholder="Enter description"
                  onChange={(e) => set('description', e.target.value)}
                />
              </label>

              <label className="field field--wide">
                <span className="field__label">Folder</span>
                <input
                  className="input"
                  type="text"
                  value={form.folder}
                  maxLength={240}
                  placeholder="Optional folder"
                  onChange={(e) => set('folder', e.target.value)}
                />
              </label>

              <label className="field field--wide">
                <span className="field__label">Proxy</span>
                <select
                  className="input"
                  value={form.proxyId}
                  onChange={(e) => {
                    set('proxyId', e.target.value);
                    setProxyTest(null);
                  }}
                >
                  <option value="">No proxy</option>
                  <option value={CUSTOM_PROXY_VALUE}>Custom proxy…</option>
                  {proxies.map((proxy) => (
                    <option key={proxy.id} value={proxy.id}>
                      {proxy.label} · {proxy.config.host}:{proxy.config.port}
                    </option>
                  ))}
                </select>
              </label>

              {isCustomProxy ? (
                <div className="field-grid field--wide custom-proxy-grid">
                  <label className="field field--wide">
                    <span className="field__label">
                      <span className="required">*</span> Proxy title
                    </span>
                    <input
                      className="input"
                      type="text"
                      value={customProxy.title}
                      autoComplete="off"
                      onChange={(e) => setCustom('title', e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Type</span>
                    <select
                      className="input"
                      value={customProxy.type}
                      onChange={(e) => setCustom('type', e.target.value as ProxyType)}
                    >
                      <option value="socks5">SOCKS5</option>
                      <option value="http">HTTP</option>
                      <option value="https">HTTPS</option>
                    </select>
                  </label>
                  <label className="field">
                    <span className="field__label">
                      <span className="required">*</span> Host
                    </span>
                    <input
                      className="input"
                      type="text"
                      value={customProxy.host}
                      placeholder="proxy.example.com"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => setCustom('host', e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">
                      <span className="required">*</span> Port
                    </span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={65535}
                      value={customProxy.port}
                      onChange={(e) => setCustom('port', e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Login</span>
                    <input
                      className="input"
                      type="text"
                      value={customProxy.login}
                      autoComplete="username"
                      onChange={(e) => setCustom('login', e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Password</span>
                    <input
                      className="input"
                      type="password"
                      value={customProxy.password}
                      autoComplete="new-password"
                      onChange={(e) => setCustom('password', e.target.value)}
                    />
                  </label>
                  <div className="custom-proxy-actions field--wide">
                    <button
                      type="button"
                      className="btn btn--outline btn--compact"
                      disabled={
                        proxyChecking ||
                        !onTestProxy ||
                        !customProxyConfig(customProxy, 'px_profile_draft')
                      }
                      onClick={() => {
                        void handleTestProxy();
                      }}
                    >
                      {proxyChecking ? 'Testing…' : 'Test connection'}
                    </button>
                    {proxyTest ? (
                      <p
                        className={
                          proxyTest.ok
                            ? 'proxy-test-result proxy-test-result--ok'
                            : 'proxy-test-result proxy-test-result--error'
                        }
                        role="status"
                      >
                        {proxyTest.ok
                          ? `Connected${proxyTest.latencyMs !== undefined ? ` · ${proxyTest.latencyMs} ms` : ''}${proxyTest.geo?.timezone ? ` · ${proxyTest.geo.timezone}` : ''}`
                          : proxyTest.error || 'Connection failed.'}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <label className="field field--wide">
                <span className="field__label">Tags</span>
                <input
                  className="input"
                  type="text"
                  value={form.tags}
                  placeholder="Tags"
                  onChange={(e) => set('tags', e.target.value)}
                />
              </label>
            </fieldset>
          </section>
        ) : null}

        {step === 'fingerprint' ? (
          <section
            className="wizard-section"
            role="tabpanel"
            id="new-profile-panel-fingerprint"
            aria-labelledby="new-profile-tab-fingerprint"
          >
            <fieldset
              className="fp-stack"
              style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
            >
              <div className="field os-version-row">
                <label className="field">
                  <span className="field__label">Operating system</span>
                  <OsSelect value={form.os} options={OS_OPTIONS} onChange={setOs} />
                </label>
                <label className="field">
                  <span className="field__label">OS version</span>
                  <select
                    className="input"
                    value={form.osVersion}
                    onChange={(e) => setOsVersion(e.target.value)}
                  >
                    {versionOptions.map((version) => (
                      <option key={version} value={version}>
                        {version}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="field field--wide">
                <span className="field__label">User-Agent</span>
                <input
                  className="input"
                  type="text"
                  aria-label="User Agent"
                  value={userAgent}
                  readOnly
                  title={userAgent}
                />
              </label>

              {isAndroid ? (
                <>
                  <label className="field">
                    <span className="field__label">Device type</span>
                    <select
                      className="input"
                      value={form.androidDeviceType}
                      onChange={(e) => setAndroidDeviceType(e.target.value as AndroidDeviceType)}
                    >
                      {ANDROID_DEVICE_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field field--wide">
                    <span className="field__label">Device model</span>
                    <SearchableSelect
                      options={androidModels}
                      value={form.androidDeviceModel}
                      onChange={(model) => set('androidDeviceModel', model)}
                      ariaLabel="Device model"
                      invalid={
                        showValidation &&
                        !findAndroidCatalogEntry(form.androidDeviceType, form.androidDeviceModel)
                      }
                      placeholder="Search Google Play device models"
                    />
                    <span className="field-hint">
                      {androidModels.length.toLocaleString()} models from Google Play’s official
                      device list · {form.osVersion} · {form.androidDeviceType}
                    </span>
                  </label>
                  <p className="field-hint field--wide">
                    The selected model sets the device name reported in the User-Agent. Screen, GPU
                    and RAM use a coherent hardware profile matched to the device — exact for
                    popular flagships, otherwise a real same-brand device. The profile opens in a
                    phone-sized window with touch/mobile emulation — no physical device or Lobium
                    APK required.
                  </p>
                </>
              ) : (
                <>
                  <label className="field">
                    <span className="field__label">Screen resolution</span>
                    <select
                      className="input"
                      value={form.screenResolution}
                      onChange={(e) => set('screenResolution', e.target.value)}
                    >
                      {screenOptions.map((screen) => (
                        <option key={screen} value={screen}>
                          {screen.replace('x', ' × ')}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="field field--wide">
                    <span className="field__label">Fonts</span>
                    {fontCatalogLoading ? (
                      <p className="field-hint" role="status">
                        Reading the installed font pack…
                      </p>
                    ) : fontCatalogError ? (
                      <p className="notice notice--error" role="alert">
                        Font pack unavailable: {fontCatalogError}
                      </p>
                    ) : (
                      <>
                        {fontPackAbsent ? (
                          <p className="field-hint" role="status">
                            No font pack installed — the profile still reports only the fonts listed
                            here, but families this machine does not have will not render.
                          </p>
                        ) : null}
                        <FontMultiSelect
                          options={form.fonts.available}
                          selected={form.fonts.selected}
                          onChange={(selected) =>
                            setForm((prev) => ({ ...prev, fonts: { ...prev.fonts, selected } }))
                          }
                        />
                      </>
                    )}
                  </div>
                </>
              )}

              <div className="fp-row">
                <label className="field">
                  <span className="field__label">Language</span>
                  <select
                    className="input"
                    value={form.languageMode}
                    onChange={(e) => set('languageMode', e.target.value as PersonaMode)}
                  >
                    {PERSONA_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                {form.languageMode === 'manual' ? (
                  <label className="field fp-row__grow">
                    <span className="field__label">Locale</span>
                    <SearchableSelect
                      options={LOCALE_OPTIONS}
                      value={primaryLocaleOf(form.languages)}
                      onChange={(locale) => set('languages', expandLocaleToLanguages(locale))}
                      ariaLabel="Language"
                      placeholder="Select a language / locale"
                    />
                    <span className="field-hint">
                      navigator.languages = {form.languages || '—'}
                    </span>
                  </label>
                ) : null}
              </div>

              <div className="fp-row">
                <label className="field">
                  <span className="field__label">Timezone</span>
                  <select
                    className="input"
                    value={form.timezoneMode}
                    onChange={(e) => set('timezoneMode', e.target.value as PersonaMode)}
                  >
                    {PERSONA_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                {form.timezoneMode === 'manual' ? (
                  <label className="field fp-row__grow">
                    <span className="field__label">Timezone value</span>
                    <SearchableSelect
                      options={TIMEZONE_OPTIONS}
                      value={form.timezone}
                      onChange={(tz) => set('timezone', tz)}
                      ariaLabel="Timezone"
                      placeholder="Search IANA timezones"
                    />
                  </label>
                ) : null}
              </div>

              <div className="fp-row">
                <label className="field">
                  <span className="field__label">Geolocation</span>
                  <select
                    className="input"
                    value={form.geolocationMode}
                    onChange={(e) => set('geolocationMode', e.target.value as PersonaMode)}
                  >
                    {PERSONA_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                {form.geolocationMode === 'manual' ? (
                  <>
                    <label className="field fp-row__grow">
                      <span className="field__label">Location</span>
                      <SearchableSelect
                        options={LOCATION_OPTIONS.map((l) => l.label)}
                        value={
                          LOCATION_OPTIONS.find(
                            (l) =>
                              String(l.latitude) === form.geolocationLat &&
                              String(l.longitude) === form.geolocationLng,
                          )?.label ?? ''
                        }
                        onChange={(label) => {
                          const loc = LOCATION_OPTIONS.find((l) => l.label === label);
                          if (!loc) return;
                          setForm((prev) => ({
                            ...prev,
                            geolocationLat: String(loc.latitude),
                            geolocationLng: String(loc.longitude),
                            geolocationAccuracy: prev.geolocationAccuracy || '100',
                          }));
                        }}
                        ariaLabel="Location"
                        placeholder="Select a city / location"
                      />
                      <span className="field-hint">
                        {form.geolocationLat && form.geolocationLng
                          ? `lat ${form.geolocationLat}, lng ${form.geolocationLng}`
                          : 'Pick a location to set coordinates'}
                      </span>
                    </label>
                    <label className="field">
                      <span className="field__label">Accuracy (m)</span>
                      <input
                        className="input"
                        type="number"
                        min={1}
                        value={form.geolocationAccuracy}
                        onChange={(e) => set('geolocationAccuracy', e.target.value)}
                      />
                    </label>
                  </>
                ) : null}
              </div>

              <label className="field">
                <span className="field__label">WebRTC</span>
                <select
                  className="input"
                  value={form.webrtcMode}
                  onChange={(e) => set('webrtcMode', e.target.value as WebRtcUiMode)}
                >
                  {WEBRTC_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {!isAndroid ? (
                <>
                  <div className="fp-row">
                    <label className="field">
                      <span className="field__label">CPU cores</span>
                      <select
                        className="input"
                        value={form.cpuCores}
                        onChange={(e) => set('cpuCores', e.target.value)}
                      >
                        {CPU_CORE_OPTIONS.map((cores) => (
                          <option key={cores} value={String(cores)}>
                            {cores}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="field">
                      <span className="field__label">Reported memory</span>
                      <select
                        className="input"
                        value={form.ramSize}
                        onChange={(e) => set('ramSize', e.target.value)}
                      >
                        {DEVICE_MEMORY_OPTIONS.map((ram) => (
                          <option key={ram} value={String(ram)}>
                            {ram} GB
                          </option>
                        ))}
                      </select>
                      <span className="field-hint">navigator.deviceMemory (Lobium values)</span>
                    </label>
                  </div>

                  <label className="field">
                    <span className="field__label">WebGL renderer</span>
                    <select
                      className="input"
                      value={form.rendererPresetId}
                      onChange={(e) => set('rendererPresetId', e.target.value)}
                    >
                      <option value="host">Host GPU</option>
                      <option value="normalized_host">Normalized host GPU</option>
                      {rendererOptions.map((renderer) => (
                        <option key={renderer.id} value={renderer.id}>
                          {renderer.label}
                        </option>
                      ))}
                    </select>
                    <span className="field-hint">
                      Host calibration is recommended. {rendererOptions.length.toLocaleString()}{' '}
                      sourced {form.os} GPU presets available.
                    </span>
                  </label>
                </>
              ) : null}
            </fieldset>

            <fieldset className="fp-inline-group" disabled={legacyAndroid}>
              <legend>Deterministic noise</legend>
              <div className="support-grid">
                {(
                  [
                    ['noiseWebgl', 'WebGL'],
                    ['noiseCanvas', 'Canvas'],
                    ['noiseAudio', 'Audio'],
                    ['noiseClientRects', 'Client rects'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="check-row">
                    <input
                      type="checkbox"
                      checked={form[key]}
                      onChange={(e) => set(key, e.target.checked)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="fp-inline-group" disabled={legacyAndroid}>
              <legend>Media devices</legend>
              <div className="field-grid">
                <label className="field">
                  <span className="field__label">Cameras</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step={1}
                    value={form.mediaCameras}
                    onChange={(e) => set('mediaCameras', e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Microphones</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step={1}
                    value={form.mediaMicrophones}
                    onChange={(e) => set('mediaMicrophones', e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Speakers</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step={1}
                    value={form.mediaSpeakers}
                    onChange={(e) => set('mediaSpeakers', e.target.value)}
                  />
                </label>
                <label className="check-row check-row--field">
                  <input
                    type="checkbox"
                    checked={form.stableDeviceIds}
                    onChange={(e) => set('stableDeviceIds', e.target.checked)}
                  />
                  <span>Stable device IDs</span>
                </label>
              </div>
            </fieldset>
          </section>
        ) : null}

        {step === 'cookies' ? (
          <section
            className="wizard-section"
            role="tabpanel"
            id="new-profile-panel-cookies"
            aria-labelledby="new-profile-tab-cookies"
          >
            <label className="field field--wide">
              <span className="field__label">Import mode</span>
              <select
                className="input"
                value={form.cookiesMode}
                onChange={(e) => set('cookiesMode', e.target.value as CookieImportMode)}
              >
                <option value="merge">Merge into cookie jar</option>
                <option value="replace">Replace cookie jar</option>
                <option value="empty">Start empty</option>
              </select>
            </label>
            {form.cookiesMode !== 'empty' ? (
              <>
                <label
                  className="drop-zone"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void handleCookieFile(e.dataTransfer.files[0]);
                  }}
                >
                  <input
                    type="file"
                    accept=".txt,.json"
                    aria-label="Choose a Netscape or JSON cookie file"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      void handleCookieFile(file);
                    }}
                  />
                  <span>{form.cookiesFileName || 'Cookie file import'}</span>
                  <em>
                    {form.cookiesParsedCount !== undefined
                      ? `${form.cookiesParsedCount} cookies detected`
                      : 'Select or drop .txt / .json'}
                  </em>
                </label>
                {form.cookiesText || form.cookiesFileName ? (
                  <div className="cookie-import-status" role="status">
                    <span>
                      {form.cookiesErrors?.length
                        ? 'Import needs attention'
                        : `${form.cookiesParsedCount ?? 0} valid cookies ready`}
                    </span>
                    <button
                      type="button"
                      className="btn btn--ghost btn--compact"
                      onClick={() => setCookieText('', '')}
                    >
                      Clear import
                    </button>
                  </div>
                ) : null}
                <label className="field field--wide">
                  <span className="field__label">Plain text cookies</span>
                  <textarea
                    className="input textarea textarea--tall"
                    value={form.cookiesText}
                    aria-invalid={Boolean(form.cookiesErrors?.length)}
                    spellCheck={false}
                    placeholder="Paste cookie text"
                    onChange={(e) => setCookieText(e.target.value, '')}
                  />
                </label>
              </>
            ) : (
              <p className="field-hint">No cookies will be imported for this profile.</p>
            )}
            {form.cookiesErrors?.length ? (
              <div className="review-warnings">
                {form.cookiesErrors.map((cookieError, index) => (
                  <p key={`${cookieError.message}-${index}`}>{cookieError.message}</p>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {step === 'security' ? (
          <section
            className="wizard-section"
            role="tabpanel"
            id="new-profile-panel-security"
            aria-labelledby="new-profile-tab-security"
          >
            <div className="field-grid">
              <label className="field">
                <span className="field__label">Password</span>
                <input
                  className="input"
                  type="password"
                  value={form.password}
                  placeholder="Optional"
                  onChange={(e) => set('password', e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label className="field">
                <span className="field__label">Confirm password</span>
                <input
                  className="input"
                  type="password"
                  value={form.passwordConfirm}
                  aria-invalid={showValidation && form.password !== form.passwordConfirm}
                  placeholder="Repeat password"
                  onChange={(e) => set('passwordConfirm', e.target.value)}
                  autoComplete="new-password"
                />
              </label>
            </div>
            <p className="field-hint">
              {editing && profile?.passwordProtected
                ? 'Leave blank to keep the current password, or enter a replacement.'
                : 'When set, launching this profile requires the password.'}
            </p>
            {editing && profile?.passwordProtected ? (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={form.removePassword}
                  onChange={(e) => set('removePassword', e.target.checked)}
                />
                <span>Remove password protection</span>
              </label>
            ) : null}
            <div className="review-warnings">
              {warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          </section>
        ) : null}

        {step === 'extensions' ? (
          <section
            className="wizard-section"
            role="tabpanel"
            id="new-profile-panel-extensions"
            aria-labelledby="new-profile-tab-extensions"
          >
            <div className="field-grid">
              <label className="field">
                <span className="field__label">Source</span>
                <select
                  className="input"
                  value={extensionSource}
                  onChange={(event) => {
                    setExtensionSource(event.target.value as BrowserExtensionRef['source']);
                    setExtensionInputError(null);
                  }}
                >
                  <option value="chrome_web_store">Chrome Web Store</option>
                  <option value="unpacked">Local unpacked directory</option>
                </select>
              </label>
              <label className="field field--wide">
                <span className="field__label">
                  {extensionSource === 'chrome_web_store'
                    ? 'Extension ID or official detail URL'
                    : 'Absolute directory path'}
                </span>
                <input
                  className="input"
                  value={extensionValue}
                  aria-invalid={Boolean(extensionInputError)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={
                    extensionSource === 'chrome_web_store'
                      ? 'abcdefghijklmnopabcdefghijklmnop'
                      : '/home/user/extensions/my-extension'
                  }
                  onChange={(event) => {
                    setExtensionValue(event.target.value);
                    setExtensionInputError(null);
                  }}
                />
              </label>
              <div className="field field--wide">
                <button type="button" className="btn btn--secondary" onClick={addExtension}>
                  Add extension
                </button>
                {extensionInputError ? (
                  <p className="notice notice--error" role="alert">
                    {extensionInputError}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="extension-list">
              {form.extensions.length === 0 ? (
                <p className="field-hint">No extensions configured.</p>
              ) : (
                form.extensions.map((extension, index) => {
                  const label =
                    extension.name ||
                    extension.id ||
                    extension.url ||
                    extension.path ||
                    `Extension ${index + 1}`;
                  const state = !extension.enabled
                    ? 'Disabled'
                    : extension.installState === 'error'
                      ? 'Install failed'
                      : extension.installState === 'ready'
                        ? 'Ready'
                        : 'Will install at next launch';
                  return (
                    <div className="extension-row" key={`${extension.source}-${label}-${index}`}>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={extension.enabled}
                          onChange={(event) =>
                            setForm((previous) => ({
                              ...previous,
                              extensions: previous.extensions.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      enabled: event.target.checked,
                                      installState: event.target.checked ? 'pending' : 'disabled',
                                    }
                                  : item,
                              ),
                            }))
                          }
                        />
                        <span>
                          <strong>{label}</strong>
                          <small>
                            {extension.source === 'chrome_web_store'
                              ? 'Chrome Web Store'
                              : 'Local unpacked'}{' '}
                            · {state}
                          </small>
                        </span>
                      </label>
                      {extension.installError ? (
                        <p className="notice notice--error">{extension.installError}</p>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn--ghost btn--compact"
                        onClick={() =>
                          setForm((previous) => ({
                            ...previous,
                            extensions: previous.extensions.filter(
                              (_item, itemIndex) => itemIndex !== index,
                            ),
                          }))
                        }
                      >
                        Remove
                      </button>
                    </div>
                  );
                })
              )}
            </div>
            <p className="field-hint">
              Store packages are fetched only for explicitly configured IDs from Google’s update
              service, then CRX3 identity/signature-verified and safely unpacked. Availability and
              use remain subject to Chrome Web Store terms.
            </p>
          </section>
        ) : null}

        {currentStepIssues.length > 0 ? (
          <div className="notice notice--error validation-summary" role="alert">
            <strong>Review this section</strong>
            <ul>
              {currentStepIssues.map((issue) => (
                <li key={issue.message}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : error ? (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <footer className="modal-footer">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
          {submitting
            ? editing
              ? 'Saving…'
              : 'Creating…'
            : editing
              ? 'Save profile'
              : 'Create profile'}
        </button>
      </footer>
    </form>
  );
}
