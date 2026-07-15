import { useMemo, useState } from 'react';
import { normalizeDeviceMemory } from '@lobster/fingerprint';

import type {
  EngineKind,
  FingerprintOverrides,
  HardwareNoisePolicy,
  LocaleFingerprint,
  MediaDeviceProfile,
  NavigatorFingerprint,
  ProfileOsTarget,
  Profile,
  RendererPolicy,
  ScreenFingerprint,
  WebRtcPolicy,
} from '@lobster/shared-types';

import type { ProfilePatch } from '../../api/tauri';
import { Badge, type BadgeTone } from '../../ui';
import { ENGINE_OPTIONS, OS_OPTIONS, OS_VERSION_OPTIONS } from '../profiles/options';
import { rendererPresetById, rendererPresetsForTarget } from '../profiles/fingerprintCatalog';
import { FIELD_SUPPORT, previewPersona, type SupportLevel } from './coherence';

function supportTone(level: SupportLevel): BadgeTone {
  if (level === 'native') return 'success';
  if (level === 'cdp') return 'info';
  return 'warning';
}

function SupportBadge({ field }: { field: string }): JSX.Element | null {
  const support = FIELD_SUPPORT[field];
  if (!support) return null;
  return (
    <span
      className="support-badge"
      title={support.note}
      aria-label={`${support.level}: ${support.note}`}
    >
      <Badge tone={supportTone(support.level)}>{support.level}</Badge>
    </span>
  );
}

interface FingerprintEditorProps {
  profile: Profile;
  onSave: (patch: ProfilePatch) => Promise<void>;
  onClose: () => void;
  saving: boolean;
}

/**
 * All editor inputs are strings (controlled fields). Blank means "no override" — the
 * seed-derived value is used at launch. On save we parse the non-blank fields into a
 * {@link FingerprintOverrides} patch.
 */
interface FpForm {
  engine: EngineKind;
  os: ProfileOsTarget;
  osVersion: string;
  platform: string;
  languages: string;
  locale: string;
  timezone: string;
  geolocationLat: string;
  geolocationLng: string;
  geolocationAccuracy: string;
  hardwareConcurrency: string;
  deviceMemory: string;
  maxTouchPoints: string;
  screenWidth: string;
  screenHeight: string;
  devicePixelRatio: string;
  renderer: string;
  webrtc: WebRtcPolicy;
  noiseWebgl: boolean;
  noiseCanvas: boolean;
  noiseAudio: boolean;
  noiseClientRects: boolean;
  mediaCameras: string;
  mediaMicrophones: string;
  mediaSpeakers: string;
  stableDeviceIds: boolean;
}

function numToStr(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function toNum(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function initForm(profile: Profile): FpForm {
  const nav = profile.fingerprintOverrides?.navigator;
  const scr = profile.fingerprintOverrides?.screen;
  const loc = profile.fingerprintOverrides?.locale;
  return {
    engine: profile.engine,
    os: profile.os,
    osVersion: profile.osVersion ?? OS_VERSION_OPTIONS[profile.os][0],
    platform: nav?.platform ?? '',
    languages: nav?.languages?.join(', ') ?? '',
    locale: loc?.locale ?? '',
    timezone: loc?.timezone ?? '',
    geolocationLat: numToStr(loc?.geolocation?.latitude),
    geolocationLng: numToStr(loc?.geolocation?.longitude),
    geolocationAccuracy: numToStr(loc?.geolocation?.accuracy ?? 100),
    hardwareConcurrency: numToStr(nav?.hardwareConcurrency),
    deviceMemory: numToStr(nav?.deviceMemory),
    maxTouchPoints: numToStr(nav?.maxTouchPoints),
    screenWidth: numToStr(scr?.width),
    screenHeight: numToStr(scr?.height),
    devicePixelRatio: numToStr(scr?.devicePixelRatio),
    renderer:
      profile.fingerprintOverrides?.renderer?.mode === 'validated_preset'
        ? profile.fingerprintOverrides.renderer.presetId
        : (profile.fingerprintOverrides?.renderer?.mode ?? 'host'),
    webrtc: profile.fingerprintOverrides?.webrtc ?? 'default_public_interface_only',
    noiseWebgl: profile.fingerprintOverrides?.hardwareNoise?.webgl ?? true,
    noiseCanvas: profile.fingerprintOverrides?.hardwareNoise?.canvas ?? true,
    noiseAudio: profile.fingerprintOverrides?.hardwareNoise?.audio ?? true,
    noiseClientRects: profile.fingerprintOverrides?.hardwareNoise?.clientRects ?? false,
    mediaCameras: numToStr(profile.fingerprintOverrides?.mediaDevices?.cameras ?? 1),
    mediaMicrophones: numToStr(profile.fingerprintOverrides?.mediaDevices?.microphones ?? 1),
    mediaSpeakers: numToStr(profile.fingerprintOverrides?.mediaDevices?.speakers ?? 2),
    stableDeviceIds: profile.fingerprintOverrides?.mediaDevices?.stableDeviceIds ?? true,
  };
}

function wholeNumberOrZero(raw: string): number {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

function rendererPolicy(selection: string, os: ProfileOsTarget): RendererPolicy {
  if (selection === 'normalized_host') return { mode: 'normalized_host' };
  const preset = rendererPresetById(os, selection);
  return preset?.policy ?? { mode: 'host' };
}

function hardwareNoise(form: FpForm): HardwareNoisePolicy {
  return {
    webgl: form.noiseWebgl,
    canvas: form.noiseCanvas,
    audio: form.noiseAudio,
    clientRects: form.noiseClientRects,
  };
}

function mediaDevices(form: FpForm): MediaDeviceProfile {
  return {
    cameras: wholeNumberOrZero(form.mediaCameras),
    microphones: wholeNumberOrZero(form.mediaMicrophones),
    speakers: wholeNumberOrZero(form.mediaSpeakers),
    stableDeviceIds: form.stableDeviceIds,
  };
}

/** Assemble the edited surfaces without discarding launch-policy fields this form does not expose. */
function toOverrides(form: FpForm, profile: Profile): FingerprintOverrides {
  const original = profile.fingerprintOverrides;
  const targetChanged = form.os !== profile.os || form.engine !== profile.engine;
  const overrides: FingerprintOverrides = { ...original };

  const nav: Partial<NavigatorFingerprint> = targetChanged ? {} : { ...original?.navigator };
  delete nav.userAgent;
  delete nav.uaBrands;
  delete nav.uaPlatform;
  delete nav.uaPlatformVersion;
  delete nav.uaMobile;
  delete nav.uaFullVersion;
  delete nav.uaModel;
  delete nav.platform;
  delete nav.languages;
  delete nav.hardwareConcurrency;
  delete nav.deviceMemory;
  delete nav.maxTouchPoints;
  const platform = form.platform.trim();
  if (platform) nav.platform = platform;
  const languages = form.languages
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  if (languages.length) nav.languages = languages;
  const hc = toNum(form.hardwareConcurrency);
  if (hc !== undefined) nav.hardwareConcurrency = hc;
  const dm = toNum(form.deviceMemory);
  // Snap to the HTML deviceMemory ladder (0.25…8) so free-typed 16/32/128 cannot fail-close launch.
  if (dm !== undefined) nav.deviceMemory = normalizeDeviceMemory(dm);
  const mtp = toNum(form.maxTouchPoints);
  if (mtp !== undefined) nav.maxTouchPoints = mtp;

  const screen: Partial<ScreenFingerprint> = targetChanged ? {} : { ...original?.screen };
  const width = toNum(form.screenWidth);
  const height = toNum(form.screenHeight);
  const dpr = toNum(form.devicePixelRatio);
  const screenChanged =
    targetChanged ||
    form.screenWidth !== numToStr(original?.screen?.width) ||
    form.screenHeight !== numToStr(original?.screen?.height) ||
    form.devicePixelRatio !== numToStr(original?.screen?.devicePixelRatio);
  if (screenChanged) {
    delete screen.width;
    delete screen.height;
    delete screen.availWidth;
    delete screen.availHeight;
    delete screen.availLeft;
    delete screen.availTop;
    delete screen.devicePixelRatio;
    if (width !== undefined) screen.width = width;
    if (height !== undefined) screen.height = height;
    if (dpr !== undefined) screen.devicePixelRatio = dpr;
    if (width !== undefined && height !== undefined) {
      const isMac = form.os === 'macos' || form.os === 'macos_intel' || form.os === 'macos_arm';
      screen.availWidth = width;
      screen.availHeight = Math.max(1, height - (isMac ? 25 : 40));
      screen.availLeft = 0;
      screen.availTop = isMac ? 25 : 0;
    }
  }

  const locale: Partial<LocaleFingerprint> = { ...original?.locale };
  delete locale.locale;
  delete locale.timezone;
  delete locale.geolocation;
  const localeTag = form.locale.trim();
  if (localeTag) locale.locale = localeTag;
  const timezone = form.timezone.trim();
  if (timezone) locale.timezone = timezone;
  const latitude = toNum(form.geolocationLat);
  const longitude = toNum(form.geolocationLng);
  if (latitude !== undefined && longitude !== undefined) {
    locale.geolocation = {
      latitude,
      longitude,
      accuracy: toNum(form.geolocationAccuracy) ?? 100,
    };
  }

  if (Object.keys(nav).length) overrides.navigator = nav;
  else delete overrides.navigator;
  if (Object.keys(screen).length) overrides.screen = screen;
  else delete overrides.screen;
  if (Object.keys(locale).length) overrides.locale = locale;
  else delete overrides.locale;

  if (targetChanged) delete overrides.fonts;

  const originalRenderer = original?.renderer;
  const originalRendererSelection =
    originalRenderer?.mode === 'validated_preset'
      ? originalRenderer.presetId
      : (originalRenderer?.mode ?? 'host');
  const selectedRenderer = rendererPresetById(form.os, form.renderer);
  overrides.renderer = rendererPolicy(form.renderer, form.os);
  if (selectedRenderer) {
    overrides.webgl = selectedRenderer.webgl;
  } else if (targetChanged || form.renderer !== originalRendererSelection) {
    delete overrides.webgl;
  }
  // Explicit editor values must win at launch. Persona modes default to based_ip/real and would
  // otherwise ignore raw webrtc/locale fields in startProfile resolve helpers.
  if (languages.length) overrides.languageMode = 'manual';
  if (timezone) overrides.timezoneMode = 'manual';
  if (latitude !== undefined && longitude !== undefined) overrides.geolocationMode = 'manual';
  overrides.webrtcMode = 'manual';
  overrides.webrtc = form.webrtc;
  overrides.hardwareNoise = hardwareNoise(form);
  overrides.mediaDevices = mediaDevices(form);
  return overrides;
}

function validLanguageTag(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function editorValidationIssues(form: FpForm): string[] {
  const issues: string[] = [];
  const languages = form.languages
    .split(',')
    .map((language) => language.trim())
    .filter(Boolean);
  if (languages.some((language) => !validLanguageTag(language))) {
    issues.push('Languages must use valid BCP-47 tags, for example en-US, en.');
  }
  if (form.locale.trim() && !validLanguageTag(form.locale.trim())) {
    issues.push('Locale must be a valid BCP-47 tag, for example en-US.');
  }
  if (form.timezone.trim() && !validTimezone(form.timezone.trim())) {
    issues.push('Timezone must be a valid IANA identifier, for example America/New_York.');
  }

  const latitude = toNum(form.geolocationLat);
  const longitude = toNum(form.geolocationLng);
  const accuracy = toNum(form.geolocationAccuracy);
  if ((latitude === undefined) !== (longitude === undefined)) {
    issues.push('Geolocation needs both latitude and longitude, or neither.');
  } else if (latitude !== undefined && longitude !== undefined) {
    if (latitude < -90 || latitude > 90) issues.push('Latitude must be from -90 to 90.');
    if (longitude < -180 || longitude > 180) issues.push('Longitude must be from -180 to 180.');
    if (accuracy === undefined || accuracy <= 0) {
      issues.push('Geolocation accuracy must be greater than zero.');
    }
  }

  const hardwareConcurrency = toNum(form.hardwareConcurrency);
  if (
    hardwareConcurrency !== undefined &&
    (!Number.isInteger(hardwareConcurrency) || hardwareConcurrency < 1)
  ) {
    issues.push('CPU cores must be a positive whole number.');
  }
  const deviceMemory = toNum(form.deviceMemory);
  if (deviceMemory !== undefined && ![0.25, 0.5, 1, 2, 4, 8].includes(deviceMemory)) {
    issues.push(
      'deviceMemory must be one of Lobium’s observable values: 0.25, 0.5, 1, 2, 4, or 8 GB.',
    );
  }
  const maxTouchPoints = toNum(form.maxTouchPoints);
  if (maxTouchPoints !== undefined && (!Number.isInteger(maxTouchPoints) || maxTouchPoints < 0)) {
    issues.push('maxTouchPoints must be a non-negative whole number.');
  }

  const width = toNum(form.screenWidth);
  const height = toNum(form.screenHeight);
  const dpr = toNum(form.devicePixelRatio);
  if ((width === undefined) !== (height === undefined)) {
    issues.push('Display override needs both width and height, or neither.');
  } else if (width !== undefined && height !== undefined) {
    if (!Number.isInteger(width) || width < 100)
      issues.push('Screen width must be at least 100 px.');
    if (!Number.isInteger(height) || height < 100)
      issues.push('Screen height must be at least 100 px.');
    if (dpr === undefined || dpr <= 0 || dpr > 4) {
      issues.push('Device pixel ratio must be greater than 0 and no more than 4.');
    }
  }

  for (const [raw, label] of [
    [form.mediaCameras, 'Camera'],
    [form.mediaMicrophones, 'Microphone'],
    [form.mediaSpeakers, 'Speaker'],
  ] as const) {
    const value = toNum(raw);
    if (value === undefined || !Number.isInteger(value) || value < 0) {
      issues.push(`${label} count must be a non-negative whole number.`);
    }
  }

  if (
    form.renderer !== 'host' &&
    form.renderer !== 'normalized_host' &&
    !rendererPresetById(form.os, form.renderer)
  ) {
    issues.push('Choose a renderer that is valid for the selected operating system.');
  }
  return issues;
}

/**
 * Editor for the JS-safe / config fingerprint surfaces (applied via clean CDP overrides).
 * Deep surfaces (canvas, WebGL, audio) are handled natively by the engine and are deliberately
 * NOT editable here.
 */
export function FingerprintEditor({
  profile,
  onSave,
  onClose,
  saving,
}: FingerprintEditorProps): JSX.Element {
  const [form, setForm] = useState<FpForm>(() => initForm(profile));
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof FpForm>(key: K, value: FpForm[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }

  const overrides = useMemo(() => toOverrides(form, profile), [form, profile]);
  const formIssues = useMemo(() => editorValidationIssues(form), [form]);
  const preview = useMemo(
    () => previewPersona(profile.fingerprintSeed, form.os, form.engine, overrides),
    [profile.fingerprintSeed, form.os, form.engine, overrides],
  );
  const blocked = formIssues.length > 0 || preview.issues.length > 0 || Boolean(preview.error);
  const rendererOptions = form.os === 'android' ? [] : rendererPresetsForTarget(form.os);
  const targetChanged = form.os !== profile.os || form.engine !== profile.engine;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (blocked) {
      setError(
        preview.error ??
          formIssues[0] ??
          'Fix coherence issues before saving — the engine would refuse this combination at launch.',
      );
      return;
    }
    const patch: ProfilePatch = {
      engine: form.engine,
      os: form.os,
      osVersion: form.osVersion,
      fingerprintOverrides: overrides,
    };
    setError(null);
    try {
      await onSave(patch);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <form className="fp-editor" onSubmit={handleSubmit}>
      <p className="coherence-note">
        These are the JS-safe surfaces, applied as clean CDP overrides on top of the profile's
        seed-derived fingerprint. Keep them coherent: values should match the claimed OS/engine and
        the proxy's geo (locale, timezone, languages). Leave a field blank to keep the seed-derived
        default. Deep surfaces — canvas, WebGL, audio — are spoofed natively by the engine and are
        not edited here.
      </p>

      <div className="persona-preview" aria-live="polite">
        <div className="persona-preview__header">
          <strong>Live persona preview</strong>
          {preview.ok && formIssues.length === 0 ? (
            <Badge tone="success" dot>
              Coherent
            </Badge>
          ) : (
            <Badge tone="danger" dot>
              Issues
            </Badge>
          )}
        </div>
        {preview.fingerprint ? (
          <dl className="persona-preview__grid">
            <div>
              <dt>User-Agent</dt>
              <dd title={preview.fingerprint.navigator.userAgent}>
                {preview.fingerprint.navigator.userAgent}
              </dd>
            </div>
            <div>
              <dt>
                Platform <SupportBadge field="platform" />
              </dt>
              <dd>{preview.fingerprint.navigator.platform}</dd>
            </div>
            <div>
              <dt>
                WebGL renderer <SupportBadge field="webglRenderer" />
              </dt>
              <dd>
                {preview.fingerprint.webgl.vendor} / {preview.fingerprint.webgl.renderer}
              </dd>
            </div>
            <div>
              <dt>
                Cores <SupportBadge field="hardwareConcurrency" />
              </dt>
              <dd>{preview.fingerprint.navigator.hardwareConcurrency}</dd>
            </div>
            <div>
              <dt>
                Memory <SupportBadge field="deviceMemory" />
              </dt>
              <dd>{preview.fingerprint.navigator.deviceMemory} GB</dd>
            </div>
          </dl>
        ) : (
          <p className="notice notice--error">{preview.error ?? 'Could not derive persona.'}</p>
        )}
        {preview.issues.length > 0 ? (
          <ul className="coherence-warnings">
            {preview.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
        {formIssues.length > 0 ? (
          <ul className="coherence-warnings">
            {formIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <fieldset className="fp-group">
        <legend>Identity</legend>
        <div className="field-grid">
          <label className="field">
            <span className="field__label">Engine</span>
            <input
              className="input"
              aria-label="Engine"
              value={ENGINE_OPTIONS.find((o) => o.value === form.engine)?.label ?? 'Lobium'}
              readOnly
            />
          </label>
          <label className="field">
            <span className="field__label">Operating system</span>
            <select
              className="input"
              value={form.os}
              disabled={profile.os === 'android'}
              onChange={(e) => {
                const os = e.target.value as ProfileOsTarget;
                setForm((prev) => ({
                  ...prev,
                  os,
                  osVersion: OS_VERSION_OPTIONS[os][0],
                  platform: '',
                  hardwareConcurrency: '',
                  deviceMemory: '',
                  maxTouchPoints: '',
                  screenWidth: '',
                  screenHeight: '',
                  devicePixelRatio: '',
                  renderer: 'host',
                }));
                setError(null);
              }}
            >
              {profile.os === 'android' ? (
                <option value="android">Android (legacy, read-only)</option>
              ) : null}
              {OS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {targetChanged ? (
            <p className="notice notice--info field--wide">
              Target-specific overrides were reset so the new OS can use a coherent seed-derived
              identity. Review the preview before saving.
            </p>
          ) : null}
          <label className="field">
            <span className="field__label">OS version</span>
            <select
              className="input"
              value={form.osVersion}
              onChange={(e) => set('osVersion', e.target.value)}
            >
              {OS_VERSION_OPTIONS[form.os].map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
          </label>
          <label className="field field--wide">
            <span className="field__label">
              navigator.platform <SupportBadge field="platform" />
            </span>
            <input
              className="input"
              type="text"
              value={form.platform}
              placeholder='e.g. "Win32", "MacIntel", "Linux x86_64"'
              onChange={(e) => set('platform', e.target.value)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="fp-group">
        <legend>Locale &amp; time</legend>
        <div className="field-grid">
          <label className="field field--wide">
            <span className="field__label">navigator.languages</span>
            <input
              className="input"
              type="text"
              value={form.languages}
              placeholder="comma separated, e.g. en-US, en"
              onChange={(e) => set('languages', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">
              Locale (BCP-47) <SupportBadge field="locale" />
            </span>
            <input
              className="input"
              type="text"
              value={form.locale}
              placeholder="e.g. en-US"
              onChange={(e) => set('locale', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">
              Timezone (IANA) <SupportBadge field="timezone" />
            </span>
            <input
              className="input"
              type="text"
              value={form.timezone}
              placeholder="e.g. America/New_York"
              onChange={(e) => set('timezone', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">
              Geolocation latitude <SupportBadge field="geolocation" />
            </span>
            <input
              className="input"
              type="number"
              min={-90}
              max={90}
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
              min={-180}
              max={180}
              step="0.000001"
              value={form.geolocationLng}
              placeholder="optional"
              onChange={(e) => set('geolocationLng', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">Accuracy (meters)</span>
            <input
              className="input"
              type="number"
              min={0.01}
              step="any"
              value={form.geolocationAccuracy}
              placeholder="100"
              onChange={(e) => set('geolocationAccuracy', e.target.value)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="fp-group">
        <legend>Hardware</legend>
        <div className="field-grid">
          <label className="field">
            <span className="field__label">
              hardwareConcurrency <SupportBadge field="hardwareConcurrency" />
            </span>
            <input
              className="input"
              type="number"
              min={1}
              step={1}
              value={form.hardwareConcurrency}
              placeholder="e.g. 8"
              onChange={(e) => set('hardwareConcurrency', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">
              deviceMemory (GB) <SupportBadge field="deviceMemory" />
            </span>
            <select
              className="input"
              value={form.deviceMemory}
              onChange={(e) => set('deviceMemory', e.target.value)}
            >
              <option value="">Seed-derived</option>
              {[0.25, 0.5, 1, 2, 4, 8].map((memory) => (
                <option key={memory} value={String(memory)}>
                  {memory} GB
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">maxTouchPoints</span>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              value={form.maxTouchPoints}
              placeholder="e.g. 0"
              onChange={(e) => set('maxTouchPoints', e.target.value)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="fp-group">
        <legend>Display</legend>
        <div className="field-grid">
          <label className="field">
            <span className="field__label">
              screen.width <SupportBadge field="screen" />
            </span>
            <input
              className="input"
              type="number"
              min={100}
              value={form.screenWidth}
              placeholder="e.g. 1920"
              onChange={(e) => set('screenWidth', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">screen.height</span>
            <input
              className="input"
              type="number"
              min={100}
              value={form.screenHeight}
              placeholder="e.g. 1080"
              onChange={(e) => set('screenHeight', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">devicePixelRatio</span>
            <input
              className="input"
              type="number"
              min={0.25}
              max={4}
              step={0.25}
              value={form.devicePixelRatio}
              placeholder="e.g. 1"
              onChange={(e) => set('devicePixelRatio', e.target.value)}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="fp-group">
        <legend>Native policy</legend>
        <div className="field-grid">
          <label className="field">
            <span className="field__label">
              Renderer <SupportBadge field="webglRenderer" />
            </span>
            <select
              className="input"
              value={form.renderer}
              onChange={(e) => set('renderer', e.target.value)}
            >
              <option value="host">Host GPU</option>
              <option value="normalized_host">Normalized host GPU</option>
              {form.renderer !== 'host' &&
              form.renderer !== 'normalized_host' &&
              !rendererPresetById(form.os, form.renderer) ? (
                <option value={form.renderer}>Unavailable preset · {form.renderer}</option>
              ) : null}
              {rendererOptions.length > 0 ? (
                <optgroup label="Verified presets">
                  {rendererOptions.map((renderer) => (
                    <option key={renderer.id} value={renderer.id}>
                      {renderer.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
          <label className="field">
            <span className="field__label">
              WebRTC <SupportBadge field="webrtc" />
            </span>
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
        </div>
        <div className="support-grid">
          {(
            [
              ['noiseWebgl', 'WebGL', 'webglDeep'],
              ['noiseCanvas', 'Canvas', 'canvasNoise'],
              ['noiseAudio', 'Audio', 'audioNoise'],
              ['noiseClientRects', 'Client Rects', 'clientRects'],
            ] as const
          ).map(([key, label, supportKey]) => (
            <label key={key} className="check-row">
              <input
                type="checkbox"
                checked={form[key]}
                onChange={(e) => set(key, e.target.checked)}
              />
              <span>
                {label} <SupportBadge field={supportKey} />
              </span>
            </label>
          ))}
        </div>
        <div className="field-grid">
          <label className="field">
            <span className="field__label">
              Cameras <SupportBadge field="mediaDevices" />
            </span>
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

      {error ? <p className="notice notice--error">{error}</p> : null}
      {blocked && !error ? (
        <p className="notice notice--error" role="alert">
          Save is blocked until coherence issues are resolved.
        </p>
      ) : null}

      <div className="form-actions">
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={saving || blocked}>
          {saving ? 'Saving…' : 'Save fingerprint'}
        </button>
      </div>
    </form>
  );
}
