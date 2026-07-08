import type { EngineKind, OsFamily, ProfileStatus } from '@lobster/shared-types';

/** Selectable engines with human labels, shared by the create form and fingerprint editor. */
export const ENGINE_OPTIONS: ReadonlyArray<{ value: EngineKind; label: string }> = [
  { value: 'lobium', label: 'Lobium (custom Chromium)' },
  { value: 'chromium', label: 'Chromium (ungoogled)' },
];

/** Selectable OS families with human labels. */
export const OS_OPTIONS: ReadonlyArray<{ value: OsFamily; label: string }> = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
];

/** Selectable OS version labels exposed in profile create/edit flows. */
export const OS_VERSION_OPTIONS: Readonly<Record<OsFamily, string[]>> = {
  windows: ['Windows 11 23H2', 'Windows 11 22H2', 'Windows 10 22H2'],
  macos: ['macOS 15 Sequoia', 'macOS 14 Sonoma', 'macOS 13 Ventura'],
  linux: ['Ubuntu 24.04', 'Ubuntu 22.04', 'Fedora 40', 'Debian 12'],
};

/** Short label for an engine value (falls back to the raw value if unknown). */
export function engineLabel(engine: EngineKind): string {
  return ENGINE_OPTIONS.find((o) => o.value === engine)?.label ?? engine;
}

/** Short label for an OS value. */
export function osLabel(os: OsFamily): string {
  return OS_OPTIONS.find((o) => o.value === os)?.label ?? os;
}

/** Presentation metadata for each profile lifecycle status. */
export const STATUS_META: Readonly<Record<ProfileStatus, { label: string; tone: string }>> = {
  idle: { label: 'Idle', tone: 'idle' },
  launching: { label: 'Launching', tone: 'pending' },
  running: { label: 'Running', tone: 'ok' },
  stopping: { label: 'Stopping', tone: 'pending' },
  error: { label: 'Error', tone: 'error' },
};
