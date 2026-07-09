import { XMarkIcon } from '@heroicons/react/24/outline';
import { useMemo, useState } from 'react';
import { parseJson, parseNetscape } from '@lobster/cookies';

import type {
  CookieImportDraft,
  CreateProfileInput,
  EngineKind,
  FingerprintOverrides,
  HardwareNoisePolicy,
  MediaDeviceProfile,
  NavigatorFingerprint,
  OsFamily,
  RendererPolicy,
  ProfileTemplate,
  WebRtcPolicy,
  StoredProxy,
} from '@lobster/shared-types';

import octiumMainIcon from '../../assets/brand/octium-main-icon.png';
import { ENGINE_OPTIONS, OS_OPTIONS, OS_VERSION_OPTIONS } from './options';

interface NewProfileFormProps {
  onCreate: (input: CreateProfileInput) => Promise<void>;
  onCancel: () => void;
  proxies?: StoredProxy[];
  templates?: ProfileTemplate[];
}

type WizardStep = 'general' | 'fingerprint' | 'cookies' | 'security' | 'extensions';

interface FormState {
  name: string;
  description: string;
  engine: EngineKind;
  os: OsFamily;
  osVersion: string;
  tags: string;
  proxyId: string;
  templateId: string;
  userAgent: string;
  screenResolution: string;
  languages: string;
  timezone: string;
  geolocationLat: string;
  geolocationLng: string;
  geolocationAccuracy: string;
  cpuCores: string;
  ramSize: string;
  renderer: RendererPolicy['mode'];
  webrtc: WebRtcPolicy;
  noiseWebgl: boolean;
  noiseCanvas: boolean;
  noiseAudio: boolean;
  noiseClientRects: boolean;
  mediaCameras: string;
  mediaMicrophones: string;
  mediaSpeakers: string;
  stableDeviceIds: boolean;
  cookiesText: string;
  cookiesFileName: string;
  cookiesParsedCount: number | undefined;
  cookiesErrors: CookieImportDraft['errors'];
  extensionUrl: string;
}

const STEPS: ReadonlyArray<{ key: WizardStep; label: string }> = [
  { key: 'general', label: 'General' },
  { key: 'fingerprint', label: 'Fingerprint' },
  { key: 'cookies', label: 'Cookies' },
  { key: 'security', label: 'Security' },
  { key: 'extensions', label: 'Extensions' },
];

const MOBILE_TARGETS = [
  { label: 'Android', status: 'planned separate mobile engine' },
] as const;

const initialState: FormState = {
  name: '',
  description: '',
  engine: 'chromium',
  os: 'windows',
  osVersion: OS_VERSION_OPTIONS.windows[0],
  tags: '',
  proxyId: '',
  templateId: '',
  userAgent: '',
  screenResolution: '1920x1080',
  languages: 'en-US, en',
  timezone: 'America/New_York',
  geolocationLat: '',
  geolocationLng: '',
  geolocationAccuracy: '100',
  cpuCores: '8',
  ramSize: '8',
  renderer: 'host',
  webrtc: 'default_public_interface_only',
  noiseWebgl: true,
  noiseCanvas: true,
  noiseAudio: true,
  noiseClientRects: false,
  mediaCameras: '1',
  mediaMicrophones: '1',
  mediaSpeakers: '2',
  stableDeviceIds: true,
  cookiesText: '',
  cookiesFileName: '',
  cookiesParsedCount: undefined,
  cookiesErrors: undefined,
  extensionUrl: '',
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

function resolutionParts(raw: string): { width: number; height: number } | undefined {
  const match = raw.match(/^(\d+)x(\d+)$/);
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function wholeNumberOrZero(raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

function rendererPolicy(mode: FormState['renderer']): RendererPolicy {
  return mode === 'normalized_host' ? { mode: 'normalized_host' } : { mode: 'host' };
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

function buildOverrides(form: FormState): FingerprintOverrides | undefined {
  const navigator: Partial<NavigatorFingerprint> = {};
  const userAgent = form.userAgent.trim();
  if (userAgent) navigator.userAgent = userAgent;
  const languages = form.languages
    .split(',')
    .map((language) => language.trim())
    .filter(Boolean);
  if (languages.length > 0) navigator.languages = languages;
  const cores = numberOrUndefined(form.cpuCores);
  if (cores !== undefined) navigator.hardwareConcurrency = cores;
  const ram = numberOrUndefined(form.ramSize);
  if (ram !== undefined) navigator.deviceMemory = ram;

  const screen = resolutionParts(form.screenResolution);
  const timezone = form.timezone.trim();
  const latitude = numberOrUndefined(form.geolocationLat);
  const longitude = numberOrUndefined(form.geolocationLng);
  const accuracy = numberOrUndefined(form.geolocationAccuracy) ?? 100;
  const overrides: FingerprintOverrides = {};
  if (Object.keys(navigator).length > 0) overrides.navigator = navigator;
  if (screen) overrides.screen = { width: screen.width, height: screen.height };
  if (timezone || (latitude !== undefined && longitude !== undefined)) {
    overrides.locale = {};
    if (timezone) overrides.locale.timezone = timezone;
    if (latitude !== undefined && longitude !== undefined) {
      overrides.locale.geolocation = { latitude, longitude, accuracy };
    }
  }
  overrides.renderer = rendererPolicy(form.renderer);
  overrides.webrtc = form.webrtc;
  overrides.hardwareNoise = hardwareNoise(form);
  overrides.mediaDevices = mediaDevices(form);
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

export function NewProfileForm({
  onCreate,
  onCancel,
  proxies = [],
  templates = [],
}: NewProfileFormProps): JSX.Element {
  const [step, setStep] = useState<WizardStep>('general');
  const [form, setForm] = useState<FormState>(initialState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = form.name.trim().length > 0 && !submitting;
  const versionOptions = OS_VERSION_OPTIONS[form.os];
  const selectedProxy = proxies.find((proxy) => proxy.id === form.proxyId);
  const selectedTemplate = templates.find((template) => template.id === form.templateId);
  const warnings = useMemo(() => {
    const items: string[] = [];
    if (form.proxyId && !selectedProxy) items.push('Selected proxy is no longer available.');
    if (form.cookiesText.trim())
      items.push('Cookie import is persisted; browser injection remains an engine task.');
    if (form.extensionUrl.trim())
      items.push('Extension reference is persisted; install-at-launch remains an engine task.');
    return items;
  }, [form, selectedProxy]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setOs(os: OsFamily): void {
    setForm((prev) => ({ ...prev, os, osVersion: OS_VERSION_OPTIONS[os][0] }));
  }

  function applyTemplate(templateId: string): void {
    const template = templates.find((item) => item.id === templateId);
    setForm((prev) => {
      if (!template) return { ...prev, templateId };
      return {
        ...prev,
        templateId,
        engine: template.engine,
        os: template.os,
        osVersion: template.osVersion ?? OS_VERSION_OPTIONS[template.os][0],
        proxyId: template.proxyId ?? prev.proxyId,
        tags: template.tags.length > 0 ? template.tags.join(', ') : prev.tags,
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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    const input: CreateProfileInput = {
      name: form.name.trim(),
      engine: form.engine,
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
    if (selectedProxy) {
      input.proxyId = selectedProxy.id;
      input.proxy = selectedProxy.config;
    }
    const notes = form.description.trim();
    if (notes) input.notes = notes;
    const overrides = buildOverrides(form);
    if (overrides) input.fingerprintOverrides = overrides;
    const cookiesText = form.cookiesText.trim();
    if (cookiesText) {
      const draft: CookieImportDraft = {
        mode: 'merge',
        source: form.cookiesFileName ? 'file' : 'plain_text',
        rawText: cookiesText,
      };
      if (form.cookiesFileName) draft.fileName = form.cookiesFileName;
      if (form.cookiesParsedCount !== undefined) draft.parsedCount = form.cookiesParsedCount;
      if (form.cookiesErrors) draft.errors = form.cookiesErrors;
      input.cookiesImport = draft;
    }
    const extensionUrl = form.extensionUrl.trim();
    if (extensionUrl) {
      input.extensions = [{ source: 'chrome_web_store', enabled: true, url: extensionUrl }];
    }

    setSubmitting(true);
    setError(null);
    try {
      await onCreate(input);
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
                  <img className="profile-icon-preview" src={octiumMainIcon} alt="" aria-hidden />
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
                  {proxies.map((proxy) => (
                    <option key={proxy.id} value={proxy.id}>
                      {proxy.label} · {proxy.config.host}:{proxy.config.port}
                    </option>
                  ))}
                </select>
              </label>

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
              <label className="field">
                <span className="field__label">Engine</span>
                <select
                  className="input"
                  value={form.engine}
                  onChange={(e) => set('engine', e.target.value as EngineKind)}
                >
                  {ENGINE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="field__label">Operating system</span>
                <select
                  className="input"
                  value={form.os}
                  onChange={(e) => setOs(e.target.value as OsFamily)}
                >
                  {OS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                  <option disabled>Android (separate mobile target planned)</option>
                </select>
              </label>

              <label className="field">
                <span className="field__label">OS version</span>
                <select
                  className="input"
                  value={form.osVersion}
                  onChange={(e) => set('osVersion', e.target.value)}
                >
                  {versionOptions.map((version) => (
                    <option key={version} value={version}>
                      {version}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field field--wide">
                <span className="field__label">User Agent</span>
                <input
                  className="input"
                  type="text"
                  value={form.userAgent}
                  placeholder="Leave blank for seed-derived value"
                  onChange={(e) => set('userAgent', e.target.value)}
                />
              </label>

              <label className="field">
                <span className="field__label">Screen resolution</span>
                <select
                  className="input"
                  value={form.screenResolution}
                  onChange={(e) => set('screenResolution', e.target.value)}
                >
                  <option value="1920x1080">1920 x 1080</option>
                  <option value="2560x1440">2560 x 1440</option>
                  <option value="1440x900">1440 x 900</option>
                  <option value="1366x768">1366 x 768</option>
                </select>
              </label>

              <label className="field">
                <span className="field__label">Languages</span>
                <input
                  className="input"
                  type="text"
                  value={form.languages}
                  onChange={(e) => set('languages', e.target.value)}
                />
              </label>

              <label className="field">
                <span className="field__label">Timezone</span>
                <input
                  className="input"
                  type="text"
                  value={form.timezone}
                  onChange={(e) => set('timezone', e.target.value)}
                />
              </label>

              <label className="field">
                <span className="field__label">Geolocation latitude</span>
                <input
                  className="input"
                  type="number"
                  step="0.000001"
                  value={form.geolocationLat}
                  placeholder="optional"
                  onChange={(e) => set('geolocationLat', e.target.value)}
                />
              </label>

              <label className="field">
                <span className="field__label">Geolocation longitude</span>
                <input
                  className="input"
                  type="number"
                  step="0.000001"
                  value={form.geolocationLng}
                  placeholder="optional"
                  onChange={(e) => set('geolocationLng', e.target.value)}
                />
              </label>

              <label className="field">
                <span className="field__label">CPU cores</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={form.cpuCores}
                  onChange={(e) => set('cpuCores', e.target.value)}
                />
              </label>

              <label className="field">
                <span className="field__label">RAM size</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={form.ramSize}
                  onChange={(e) => set('ramSize', e.target.value)}
                />
              </label>

              <label className="field">
                <span className="field__label">Renderer</span>
                <select
                  className="input"
                  value={form.renderer}
                  onChange={(e) => set('renderer', e.target.value as FormState['renderer'])}
                >
                  <option value="host">Host GPU</option>
                  <option value="normalized_host">Normalized host GPU</option>
                  <option disabled>Intel UHD Graphics preset</option>
                  <option disabled>NVIDIA Quadro preset</option>
                  <option disabled>AMD Radeon preset</option>
                </select>
              </label>
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

            <div className="mobile-targets">
              {MOBILE_TARGETS.map((target) => (
                <span key={target.label}>
                  {target.label}
                  <em>{target.status}</em>
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {step === 'cookies' ? (
          <section className="wizard-section">
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
                <span className="field__label">WebRTC</span>
                <select
                  className="input"
                  value={form.webrtc}
                  onChange={(e) => set('webrtc', e.target.value as WebRtcPolicy)}
                >
                  <option value="default_public_interface_only">Default public interface</option>
                  <option value="disable_non_proxied_udp">Disable non-proxied UDP</option>
                  <option value="proxy_only">Proxy only</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              <label className="field">
                <span className="field__label">Password</span>
                <input className="input" type="password" placeholder="Optional" disabled />
              </label>
            </div>
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
