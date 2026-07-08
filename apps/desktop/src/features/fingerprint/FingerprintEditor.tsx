import { useState } from 'react';

import type {
  EngineKind,
  FingerprintOverrides,
  HardwareNoisePolicy,
  LocaleFingerprint,
  MediaDeviceProfile,
  NavigatorFingerprint,
  OsFamily,
  Profile,
  RendererPolicy,
  ScreenFingerprint,
  WebRtcPolicy,
} from '@lobster/shared-types';

import type { ProfilePatch } from '../../api/tauri';
import { ENGINE_OPTIONS, OS_OPTIONS, OS_VERSION_OPTIONS } from '../profiles/options';

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
  os: OsFamily;
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
    renderer: profile.fingerprintOverrides?.renderer?.mode ?? 'host',
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

function rendererPolicy(mode: RendererPolicy['mode']): RendererPolicy {
  return mode === 'normalized_host' ? { mode: 'normalized_host' } : { mode: 'host' };
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

/**
 * Assemble a {@link FingerprintOverrides} from the form. Only non-blank fields become
 * overrides; empty sub-objects are dropped; any pre-existing `fonts` override (not editable
 * here) is preserved. Keys are added conditionally so nothing is set to a literal `undefined`.
 */
function toOverrides(form: FpForm, profile: Profile): FingerprintOverrides {
  const nav: Partial<NavigatorFingerprint> = {};
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
  if (dm !== undefined) nav.deviceMemory = dm;
  const mtp = toNum(form.maxTouchPoints);
  if (mtp !== undefined) nav.maxTouchPoints = mtp;

  const screen: Partial<ScreenFingerprint> = {};
  const width = toNum(form.screenWidth);
  if (width !== undefined) screen.width = width;
  const height = toNum(form.screenHeight);
  if (height !== undefined) screen.height = height;
  const dpr = toNum(form.devicePixelRatio);
  if (dpr !== undefined) screen.devicePixelRatio = dpr;

  const locale: Partial<LocaleFingerprint> = {};
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

  const overrides: FingerprintOverrides = {};
  if (Object.keys(nav).length) overrides.navigator = nav;
  if (Object.keys(screen).length) overrides.screen = screen;
  if (Object.keys(locale).length) overrides.locale = locale;
  const fonts = profile.fingerprintOverrides?.fonts;
  if (fonts) overrides.fonts = fonts;
  overrides.renderer = rendererPolicy(form.renderer);
  overrides.webrtc = form.webrtc;
  overrides.hardwareNoise = hardwareNoise(form);
  overrides.mediaDevices = mediaDevices(form);
  return overrides;
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
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const patch: ProfilePatch = {
      engine: form.engine,
      os: form.os,
      osVersion: form.osVersion,
      fingerprintOverrides: toOverrides(form, profile),
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

      <fieldset className="fp-group">
        <legend>Identity</legend>
        <div className="field-grid">
          <label className="field">
            <span className="field__label">Engine</span>
            <select
              className="input"
              value={form.engine}
              onChange={(e) => set('engine', e.target.value as EngineKind)}
            >
              {ENGINE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Operating system</span>
            <select
              className="input"
              value={form.os}
              onChange={(e) => {
                const os = e.target.value as OsFamily;
                setForm((prev) => ({ ...prev, os, osVersion: OS_VERSION_OPTIONS[os][0] }));
              }}
            >
              {OS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              <option disabled>Android (separate mobile engine planned)</option>
            </select>
          </label>
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
            <span className="field__label">navigator.platform</span>
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
            <span className="field__label">Locale (BCP-47)</span>
            <input
              className="input"
              type="text"
              value={form.locale}
              placeholder="e.g. en-US"
              onChange={(e) => set('locale', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">Timezone (IANA)</span>
            <input
              className="input"
              type="text"
              value={form.timezone}
              placeholder="e.g. America/New_York"
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
        </div>
      </fieldset>

      <fieldset className="fp-group">
        <legend>Hardware</legend>
        <div className="field-grid">
          <label className="field">
            <span className="field__label">hardwareConcurrency</span>
            <input
              className="input"
              type="number"
              min={1}
              value={form.hardwareConcurrency}
              placeholder="e.g. 8"
              onChange={(e) => set('hardwareConcurrency', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">deviceMemory (GB)</span>
            <input
              className="input"
              type="number"
              min={0}
              step={0.5}
              value={form.deviceMemory}
              placeholder="e.g. 8"
              onChange={(e) => set('deviceMemory', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">maxTouchPoints</span>
            <input
              className="input"
              type="number"
              min={0}
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
            <span className="field__label">screen.width</span>
            <input
              className="input"
              type="number"
              min={0}
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
              min={0}
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
              min={0}
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
            <span className="field__label">Renderer</span>
            <select
              className="input"
              value={form.renderer}
              onChange={(e) => set('renderer', e.target.value as RendererPolicy['mode'])}
            >
              <option value="host">Host GPU</option>
              <option value="normalized_host">Normalized host GPU</option>
              <option disabled>Intel UHD Graphics preset</option>
              <option disabled>NVIDIA Quadro preset</option>
              <option disabled>AMD Radeon preset</option>
            </select>
          </label>
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
      </fieldset>

      {error ? <p className="notice notice--error">{error}</p> : null}

      <div className="form-actions">
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save fingerprint'}
        </button>
      </div>
    </form>
  );
}
