import { XMarkIcon } from '@heroicons/react/24/outline';
import { useMemo, useState } from 'react';
import { parseJson, parseNetscape } from '@lobster/cookies';
import { normalizeDeviceMemory } from '@lobster/fingerprint';

import type {
  CookieImportDraft,
  CookieImportMode,
  CreateProfileInput,
  CreateStoredProxyInput,
  FingerprintOverrides,
  HardwareNoisePolicy,
  MediaDeviceProfile,
  NavigatorFingerprint,
  ProfileOsTarget,
  ProfileTemplate,
  ProxyConfig,
  ProxyType,
  StoredProxy,
} from '@lobster/shared-types';

import lobsterIcon from '../../assets/brand/lobster-icon.png';
import { OS_OPTIONS, OS_VERSION_OPTIONS } from './options';
import {
  ANDROID_DEVICE_TYPE_OPTIONS,
  CPU_CORE_OPTIONS,
  PHYSICAL_RAM_OPTIONS,
  PERSONA_MODE_OPTIONS,
  WEBRTC_MODE_OPTIONS,
  androidModelsForSelection,
  chromeFullVersionForMajor,
  chromeMajorFromUserAgent,
  defaultSelectedFontsForTarget,
  defaultUserAgent,
  findAndroidCatalogEntry,
  fontPresetsForTarget,
  parseScreenOption,
  rendererPresetById,
  rendererPresetsForTarget,
  screenOptionsForTarget,
  uaPlatformVersionForSelection,
  webRtcPolicyForUiMode,
  type AndroidDeviceType,
  type PersonaMode,
  type WebRtcUiMode,
} from './fingerprintCatalog';

interface NewProfileFormProps {
  onCreate: (input: CreateProfileInput, options?: { password?: string }) => Promise<void>;
  onCancel: () => void;
  onCreateProxy?: (input: CreateStoredProxyInput) => Promise<StoredProxy>;
  proxies?: StoredProxy[];
  templates?: ProfileTemplate[];
}

type WizardStep = 'general' | 'fingerprint' | 'cookies' | 'security' | 'extensions';

interface FormState {
  name: string;
  description: string;
  os: ProfileOsTarget;
  osVersion: string;
  tags: string;
  proxyId: string;
  templateId: string;
  userAgent: string;
  androidDeviceType: AndroidDeviceType;
  androidDeviceModel: string;
  screenResolution: string;
  selectedFonts: string[];
  languageMode: PersonaMode;
  languages: string;
  timezoneMode: PersonaMode;
  timezone: string;
  geolocationMode: PersonaMode;
  geolocationLat: string;
  geolocationLng: string;
  geolocationAccuracy: string;
  cpuCores: string;
  ramSize: string;
  rendererPresetId: string;
  webrtcMode: WebRtcUiMode;
  noiseWebgl: boolean;
  noiseCanvas: boolean;
  noiseAudio: boolean;
  noiseClientRects: boolean;
  mediaCameras: string;
  mediaMicrophones: string;
  mediaSpeakers: string;
  stableDeviceIds: boolean;
  cookiesMode: CookieImportMode;
  cookiesText: string;
  cookiesFileName: string;
  cookiesParsedCount: number | undefined;
  cookiesErrors: CookieImportDraft['errors'];
  password: string;
  passwordConfirm: string;
  extensionUrl: string;
}

interface CustomProxyDraft {
  title: string;
  type: ProxyType;
  host: string;
  port: string;
  login: string;
  password: string;
}

const STEPS: ReadonlyArray<{ key: WizardStep; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'fingerprint', label: 'Fingerprint' },
  { key: 'cookies', label: 'Cookies' },
  { key: 'security', label: 'Security' },
  { key: 'extensions', label: 'Extensions' },
];

const CUSTOM_PROXY_VALUE = '__custom__';

function initialFonts(os: ProfileOsTarget): string[] {
  return defaultSelectedFontsForTarget(os);
}

const initialState: FormState = {
  name: '',
  description: '',
  os: 'windows',
  osVersion: OS_VERSION_OPTIONS.windows[0],
  tags: '',
  proxyId: '',
  templateId: '',
  userAgent: defaultUserAgent('windows', 'mobile'),
  androidDeviceType: 'mobile',
  androidDeviceModel: androidModelsForSelection('mobile', OS_VERSION_OPTIONS.android[0])[0] ?? '',
  screenResolution: '1920x1080',
  selectedFonts: initialFonts('windows'),
  languageMode: 'based_ip',
  languages: 'en-US, en',
  timezoneMode: 'based_ip',
  timezone: 'America/New_York',
  geolocationMode: 'based_ip',
  geolocationLat: '',
  geolocationLng: '',
  geolocationAccuracy: '100',
  cpuCores: '8',
  ramSize: '8',
  rendererPresetId: rendererPresetsForTarget('windows')[0]?.id ?? '',
  webrtcMode: 'based_ip',
  noiseWebgl: true,
  noiseCanvas: true,
  noiseAudio: true,
  noiseClientRects: false,
  mediaCameras: '1',
  mediaMicrophones: '1',
  mediaSpeakers: '2',
  stableDeviceIds: true,
  cookiesMode: 'merge',
  cookiesText: '',
  cookiesFileName: '',
  cookiesParsedCount: undefined,
  cookiesErrors: undefined,
  password: '',
  passwordConfirm: '',
  extensionUrl: '',
};

const emptyCustomProxy: CustomProxyDraft = {
  title: '',
  type: 'socks5',
  host: '',
  port: '',
  login: '',
  password: '',
};

function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const tag = part.trim();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

function numberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function uaPlatformForTarget(os: ProfileOsTarget): string | undefined {
  if (os === 'windows') return 'Windows';
  if (os === 'macos' || os === 'macos_intel' || os === 'macos_arm') return 'macOS';
  if (os === 'linux') return 'Linux';
  if (os === 'android') return 'Android';
  return undefined;
}

function wholeNumberOrZero(raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

function hardwareNoise(form: FormState): HardwareNoisePolicy {
  return {
    webgl: form.noiseWebgl,
    canvas: form.noiseCanvas,
    audio: form.noiseAudio,
    clientRects: form.noiseClientRects,
  };
}

function mediaDevices(form: FormState): MediaDeviceProfile {
  return {
    cameras: wholeNumberOrZero(form.mediaCameras),
    microphones: wholeNumberOrZero(form.mediaMicrophones),
    speakers: wholeNumberOrZero(form.mediaSpeakers),
    stableDeviceIds: form.stableDeviceIds,
  };
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

function buildOverrides(form: FormState): FingerprintOverrides {
  const navigator: Partial<NavigatorFingerprint> = {};
  const userAgent = defaultUserAgent(form.os, form.androidDeviceType);
  navigator.userAgent = userAgent;
  const major = chromeMajorFromUserAgent(userAgent);
  if (major) {
    navigator.uaBrands = [
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
      { brand: 'Not_A Brand', version: '24' },
    ];
    navigator.uaFullVersion = chromeFullVersionForMajor(major);
  }
  const uaPlatform = uaPlatformForTarget(form.os);
  if (uaPlatform) navigator.uaPlatform = uaPlatform;
  const uaPlatformVersion = uaPlatformVersionForSelection(form.os, form.osVersion);
  if (uaPlatformVersion) navigator.uaPlatformVersion = uaPlatformVersion;
  if (form.os === 'android') {
    navigator.uaMobile = form.androidDeviceType === 'mobile';
    navigator.uaModel = form.androidDeviceModel;
    navigator.platform = 'Linux armv81';
    navigator.maxTouchPoints = form.androidDeviceType === 'mobile' ? 5 : 10;
  }
  if (form.languageMode === 'manual') {
    const languages = form.languages
      .split(',')
      .map((language) => language.trim())
      .filter(Boolean);
    if (languages.length > 0) navigator.languages = languages;
  }

  const isDesktop = form.os !== 'android';
  if (isDesktop) {
    const cores = numberOrUndefined(form.cpuCores);
    if (cores !== undefined) navigator.hardwareConcurrency = cores;
    // UI shows physical RAM (8–128); Chromium only reports ≤8 via deviceMemory.
    const ram = numberOrUndefined(form.ramSize);
    if (ram !== undefined) navigator.deviceMemory = normalizeDeviceMemory(ram);
  }

  const screen = parseScreenOption(form.screenResolution);
  const timezone = form.timezone.trim();
  const latitude = numberOrUndefined(form.geolocationLat);
  const longitude = numberOrUndefined(form.geolocationLng);
  const accuracy = numberOrUndefined(form.geolocationAccuracy) ?? 100;
  const overrides: FingerprintOverrides = {
    fontsMode: 'manual',
    languageMode: form.languageMode,
    timezoneMode: form.timezoneMode,
    geolocationMode: form.geolocationMode,
    webrtcMode: form.webrtcMode === 'disable_udp' ? 'manual' : form.webrtcMode,
  };
  if (Object.keys(navigator).length > 0) overrides.navigator = navigator;
  if (isDesktop && screen) {
    const isMac = form.os === 'macos' || form.os === 'macos_intel' || form.os === 'macos_arm';
    const menuBar = isMac ? 25 : 0;
    const bottomBar = isMac ? 0 : 40;
    overrides.screen = {
      width: screen.width,
      height: screen.height,
      availWidth: screen.width,
      availHeight: Math.max(1, screen.height - menuBar - bottomBar),
      availLeft: 0,
      availTop: menuBar,
      devicePixelRatio: screen.devicePixelRatio,
    };
  }
  if (
    form.timezoneMode === 'manual' ||
    (form.geolocationMode === 'manual' && latitude !== undefined && longitude !== undefined)
  ) {
    overrides.locale = {};
    if (form.timezoneMode === 'manual' && timezone) overrides.locale.timezone = timezone;
    if (form.geolocationMode === 'manual' && latitude !== undefined && longitude !== undefined) {
      overrides.locale.geolocation = { latitude, longitude, accuracy };
    }
  }
  if (isDesktop && form.selectedFonts.length > 0) {
    overrides.fonts = [...form.selectedFonts];
  }
  if (isDesktop && form.rendererPresetId) {
    const selectedRenderer = rendererPresetById(form.os, form.rendererPresetId);
    overrides.renderer = { mode: 'validated_preset', presetId: form.rendererPresetId };
    if (selectedRenderer) overrides.webgl = selectedRenderer.webgl;
  }
  overrides.webrtc = webRtcPolicyForUiMode(form.webrtcMode);
  overrides.hardwareNoise = hardwareNoise(form);
  overrides.mediaDevices = mediaDevices(form);
  if (form.os === 'android') {
    overrides.androidDeviceType = form.androidDeviceType;
    overrides.androidDeviceModel = form.androidDeviceModel;
    const entry = findAndroidCatalogEntry(form.androidDeviceType, form.androidDeviceModel);
    if (entry?.model) overrides.androidDeviceCode = entry.model;
  }
  return overrides;
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
    <div className="font-multiselect">
      <div className="font-multiselect__toolbar">
        <input
          className="input"
          type="search"
          value={query}
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
  );
}

export function NewProfileForm({
  onCreate,
  onCancel,
  onCreateProxy,
  proxies = [],
  templates = [],
}: NewProfileFormProps): JSX.Element {
  const [step, setStep] = useState<WizardStep>('general');
  const [form, setForm] = useState<FormState>(initialState);
  const [customProxy, setCustomProxy] = useState<CustomProxyDraft>(emptyCustomProxy);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = form.name.trim().length > 0 && !submitting;
  const versionOptions = OS_VERSION_OPTIONS[form.os];
  const screenOptions = screenOptionsForTarget(form.os);
  const rendererOptions = rendererPresetsForTarget(form.os);
  const fontOptions = fontPresetsForTarget(form.os);
  const androidModels = androidModelsForSelection(form.androidDeviceType, form.osVersion);
  const selectedProxy = proxies.find((proxy) => proxy.id === form.proxyId);
  const selectedTemplate = templates.find((template) => template.id === form.templateId);
  const isAndroid = form.os === 'android';
  const isCustomProxy = form.proxyId === CUSTOM_PROXY_VALUE;

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
    if (form.extensionUrl.trim()) {
      items.push('Extension reference is persisted; install-at-launch remains an engine task.');
    }
    return items;
  }, [form, selectedProxy, isCustomProxy]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setCustom<K extends keyof CustomProxyDraft>(key: K, value: CustomProxyDraft[K]): void {
    setCustomProxy((prev) => ({ ...prev, [key]: value }));
  }

  function setOs(os: ProfileOsTarget): void {
    const nextScreens = screenOptionsForTarget(os);
    const nextVersion = OS_VERSION_OPTIONS[os][0];
    const nextModels =
      os === 'android' ? androidModelsForSelection('mobile', nextVersion) : [];
    const nextRenderers = rendererPresetsForTarget(os);
    setForm((prev) => ({
      ...prev,
      os,
      osVersion: nextVersion,
      userAgent: defaultUserAgent(os, prev.androidDeviceType),
      screenResolution: nextScreens[0] ?? prev.screenResolution,
      selectedFonts: os === 'android' ? [] : defaultSelectedFontsForTarget(os),
      rendererPresetId: nextRenderers[0]?.id ?? '',
      androidDeviceModel: nextModels[0] ?? prev.androidDeviceModel,
    }));
  }

  function setAndroidDeviceType(androidDeviceType: AndroidDeviceType): void {
    const models = androidModelsForSelection(androidDeviceType, form.osVersion);
    setForm((prev) => ({
      ...prev,
      androidDeviceType,
      androidDeviceModel: models[0] ?? prev.androidDeviceModel,
      userAgent: defaultUserAgent(prev.os, androidDeviceType),
    }));
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
  }

  function applyTemplate(templateId: string): void {
    const template = templates.find((item) => item.id === templateId);
    setForm((prev) => {
      if (!template) return { ...prev, templateId };
      return {
        ...prev,
        templateId,
        os: template.os,
        osVersion: template.osVersion ?? OS_VERSION_OPTIONS[template.os][0],
        proxyId: template.proxyId ?? prev.proxyId,
        tags: template.tags.length > 0 ? template.tags.join(', ') : prev.tags,
        selectedFonts:
          template.os === 'android' ? [] : defaultSelectedFontsForTarget(template.os),
      };
    });
  }

  function setCookieText(rawText: string, fileName = form.cookiesFileName): void {
    const parsed = parseCookieDraft(rawText, fileName);
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
    const rawText = await file.text();
    setCookieText(rawText, file.name);
  }

  function buildCustomProxyInput(): CreateStoredProxyInput | null {
    const parsedPort = portNumber(customProxy.port.trim());
    if (!customProxy.title.trim() || !customProxy.host.trim() || parsedPort === null) return null;
    const config: ProxyConfig = {
      id: `px_${crypto.randomUUID().replaceAll('-', '')}`,
      type: customProxy.type,
      host: customProxy.host.trim(),
      port: parsedPort,
      label: customProxy.title.trim(),
    };
    const username = customProxy.login.trim();
    if (username) config.username = username;
    if (customProxy.password) config.password = customProxy.password;
    return {
      source: 'mine',
      label: customProxy.title.trim(),
      config,
    };
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;

    if (form.password && form.password !== form.passwordConfirm) {
      setError('Password confirmation does not match.');
      setStep('security');
      return;
    }

    const input: CreateProfileInput = {
      name: form.name.trim(),
      engine: 'lobium',
      os: form.os,
      osVersion: form.osVersion,
      tags: parseTags(form.tags),
    };
    if (selectedTemplate) {
      input.templateId = selectedTemplate.id;
      if (selectedTemplate.fingerprintOverrides) {
        input.fingerprintOverrides = selectedTemplate.fingerprintOverrides;
      }
      if (selectedTemplate.cookiesImport) input.cookiesImport = selectedTemplate.cookiesImport;
      if (selectedTemplate.extensions) input.extensions = selectedTemplate.extensions;
    }

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
        input.proxy = createdProxy.config;
      } else if (selectedProxy) {
        input.proxyId = selectedProxy.id;
        input.proxy = selectedProxy.config;
      }

      const notes = form.description.trim();
      if (notes) input.notes = notes;
      input.fingerprintOverrides = buildOverrides(form);

      if (form.cookiesMode === 'empty') {
        input.cookiesImport = { mode: 'empty' };
      } else {
        const cookiesText = form.cookiesText.trim();
        if (cookiesText) {
          const draft: CookieImportDraft = {
            mode: form.cookiesMode,
            source: form.cookiesFileName ? 'file' : 'plain_text',
            rawText: cookiesText,
          };
          if (form.cookiesFileName) draft.fileName = form.cookiesFileName;
          if (form.cookiesParsedCount !== undefined) draft.parsedCount = form.cookiesParsedCount;
          if (form.cookiesErrors) draft.errors = form.cookiesErrors;
          input.cookiesImport = draft;
        }
      }

      const extensionUrl = form.extensionUrl.trim();
      if (extensionUrl) {
        input.extensions = [{ source: 'chrome_web_store', enabled: true, url: extensionUrl }];
      }

      const password = form.password.trim();
      await onCreate(input, password ? { password } : undefined);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <form className="wizard modal" onSubmit={handleSubmit} aria-label="Create profile">
      <header className="modal-header">
        <h2>New Profile</h2>
        <button type="button" className="icon-button" onClick={onCancel} aria-label="Close">
          <XMarkIcon aria-hidden />
        </button>
      </header>

      <div className="wizard-steps">
        {STEPS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={item.key === step ? 'wizard-step wizard-step--active' : 'wizard-step'}
            onClick={() => setStep(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="modal-body wizard-body">
        {step === 'general' ? (
          <section className="wizard-section">
            <div className="field-grid">
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

              <div className="field field--wide">
                <span className="field__label">
                  <span className="required">*</span> Profile name
                </span>
                <div className="profile-name-row">
                  <img className="profile-icon-preview" src={lobsterIcon} alt="" aria-hidden />
                  <input
                    className="input"
                    type="text"
                    value={form.name}
                    placeholder="Enter profile name"
                    onChange={(e) => set('name', e.target.value)}
                    autoFocus
                  />
                </div>
              </div>

              <label className="field field--wide">
                <span className="field__label">Description</span>
                <textarea
                  className="input textarea textarea--profile"
                  value={form.description}
                  placeholder="Enter description"
                  onChange={(e) => set('description', e.target.value)}
                />
              </label>

              <label className="field field--wide">
                <span className="field__label">Proxy</span>
                <select
                  className="input"
                  value={form.proxyId}
                  onChange={(e) => set('proxyId', e.target.value)}
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
                      onChange={(e) => setCustom('login', e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Password</span>
                    <input
                      className="input"
                      type="password"
                      value={customProxy.password}
                      onChange={(e) => setCustom('password', e.target.value)}
                    />
                  </label>
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
            </div>
          </section>
        ) : null}

        {step === 'fingerprint' ? (
          <section className="wizard-section">
            <div className="field-grid">
              <div className="field field--wide os-version-row">
                <label className="field">
                  <span className="field__label">Operating system</span>
                  <select
                    className="input"
                    value={form.os}
                    onChange={(e) => setOs(e.target.value as ProfileOsTarget)}
                  >
                    {OS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
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
                <span className="field__label">User Agent</span>
                <input
                  className="input"
                  type="text"
                  aria-label="User Agent"
                  value={form.userAgent}
                  readOnly
                  title="Derived from Operating system and Lobium Chrome version"
                />
              </label>

              {isAndroid ? (
                <>
                  <label className="field">
                    <span className="field__label">Device Type</span>
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
                    <span className="field__label">Device Model</span>
                    <input
                      className="input"
                      list="android-device-models"
                      value={form.androidDeviceModel}
                      placeholder="Search verified Play device models"
                      onChange={(e) => set('androidDeviceModel', e.target.value)}
                    />
                    <datalist id="android-device-models">
                      {androidModels.slice(0, 2500).map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </datalist>
                    <span className="field-hint">
                      {androidModels.length.toLocaleString()} verified models for {form.osVersion} ·{' '}
                      {form.androidDeviceType}
                    </span>
                  </label>
                  <p className="field-hint field--wide">
                    Android Lobium is a separate mobile engine track. Desktop launch stays blocked
                    until the APK/device runner ships. Hardware settings are omitted for Android.
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
                    <FontMultiSelect
                      options={fontOptions}
                      selected={form.selectedFonts}
                      onChange={(selectedFonts) => set('selectedFonts', selectedFonts)}
                    />
                  </div>
                </>
              )}

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
                <label className="field">
                  <span className="field__label">Languages</span>
                  <input
                    className="input"
                    type="text"
                    value={form.languages}
                    onChange={(e) => set('languages', e.target.value)}
                  />
                </label>
              ) : null}

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
                <label className="field">
                  <span className="field__label">Timezone value</span>
                  <input
                    className="input"
                    type="text"
                    value={form.timezone}
                    onChange={(e) => set('timezone', e.target.value)}
                  />
                </label>
              ) : null}

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
                  <label className="field">
                    <span className="field__label">Latitude</span>
                    <input
                      className="input"
                      type="number"
                      step="0.000001"
                      value={form.geolocationLat}
                      onChange={(e) => set('geolocationLat', e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Longitude</span>
                    <input
                      className="input"
                      type="number"
                      step="0.000001"
                      value={form.geolocationLng}
                      onChange={(e) => set('geolocationLng', e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Accuracy</span>
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
                    <span className="field__label">RAM size (GB)</span>
                    <select
                      className="input"
                      value={form.ramSize}
                      onChange={(e) => set('ramSize', e.target.value)}
                    >
                      {PHYSICAL_RAM_OPTIONS.map((ram) => (
                        <option key={ram} value={String(ram)}>
                          {ram} GB
                        </option>
                      ))}
                    </select>
                    <span className="field-hint">
                      Stored as deviceMemory {normalizeDeviceMemory(Number(form.ramSize) || 8)} GB
                      (Chromium ladder)
                    </span>
                  </label>

                  <label className="field field--wide">
                    <span className="field__label">WebGL renderer</span>
                    <select
                      className="input"
                      value={form.rendererPresetId}
                      onChange={(e) => set('rendererPresetId', e.target.value)}
                    >
                      <option value="">Select a verified renderer</option>
                      {rendererOptions.map((renderer) => (
                        <option key={renderer.id} value={renderer.id}>
                          {renderer.label}
                        </option>
                      ))}
                    </select>
                    <span className="field-hint">
                      {rendererOptions.length.toLocaleString()} verified {form.os} renderers
                    </span>
                  </label>
                </>
              ) : null}
            </div>

            <div className="support-grid">
              {(
                [
                  ['noiseWebgl', 'WebGL'],
                  ['noiseCanvas', 'Canvas'],
                  ['noiseAudio', 'Audio'],
                  ['noiseClientRects', 'Client Rects'],
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

            <div className="field-grid">
              <label className="field">
                <span className="field__label">Cameras</span>
                <input
                  className="input"
                  type="number"
                  min={0}
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
          </section>
        ) : null}

        {step === 'cookies' ? (
          <section className="wizard-section">
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
                    onChange={(e) => {
                      void handleCookieFile(e.target.files?.[0]);
                    }}
                  />
                  <span>{form.cookiesFileName || 'Cookie file import'}</span>
                  <em>
                    {form.cookiesParsedCount !== undefined
                      ? `${form.cookiesParsedCount} cookies detected`
                      : 'Select or drop .txt / .json'}
                  </em>
                </label>
                <label className="field field--wide">
                  <span className="field__label">Plain text cookies</span>
                  <textarea
                    className="input textarea textarea--tall"
                    value={form.cookiesText}
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
          <section className="wizard-section">
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
                  placeholder="Repeat password"
                  onChange={(e) => set('passwordConfirm', e.target.value)}
                  autoComplete="new-password"
                />
              </label>
            </div>
            <p className="field-hint">
              When set, launching this profile requires the password. Leave blank for no protection.
            </p>
            <div className="review-warnings">
              {warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          </section>
        ) : null}

        {step === 'extensions' ? (
          <section className="wizard-section">
            <label className="field field--wide">
              <span className="field__label">Chrome Web Store link</span>
              <input
                className="input"
                type="url"
                value={form.extensionUrl}
                placeholder="https://chromewebstore.google.com/detail/..."
                onChange={(e) => set('extensionUrl', e.target.value)}
              />
            </label>
          </section>
        ) : null}

        {error ? <p className="notice notice--error">{error}</p> : null}
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
          {submitting ? 'Creating…' : 'Create Profile'}
        </button>
      </footer>
    </form>
  );
}
