import type {
  CpuArch,
  EngineKind,
  OsFamily,
  ProfileOsTarget,
  ProfileStatus,
} from '@lobster/shared-types';

/** Selectable engines with human labels, shared by the create form and fingerprint editor. */
export const ENGINE_OPTIONS: ReadonlyArray<{ value: EngineKind; label: string }> = [
  { value: 'lobium', label: 'Lobium' },
];

/** Selectable OS families with human labels. */
export const OS_OPTIONS: ReadonlyArray<{ value: ProfileOsTarget; label: string }> = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos_intel', label: 'macOS Intel' },
  { value: 'macos_arm', label: 'macOS Arm' },
  { value: 'linux', label: 'Linux' },
  { value: 'android', label: 'Android' },
];

/** Selectable OS version labels exposed in profile create/edit flows. */
export const OS_VERSION_OPTIONS: Readonly<Record<ProfileOsTarget, string[]>> = {
  windows: ['Windows 11', 'Windows 10'],
  macos: ['macOS 15 Sequoia', 'macOS 14 Sonoma', 'macOS 13 Ventura'],
  macos_intel: ['macOS 26 Tahoe', 'macOS 15 Sequoia', 'macOS 14 Sonoma', 'macOS 13 Ventura'],
  macos_arm: ['macOS 26 Tahoe', 'macOS 15 Sequoia', 'macOS 14 Sonoma', 'macOS 13 Ventura'],
  linux: ['Ubuntu 24.04', 'Ubuntu 22.04', 'Fedora 40', 'Debian 12'],
  android: ['Android 17', 'Android 16', 'Android 15', 'Android 14', 'Android 13'],
};

/** Product OS targets that can run through the desktop Lobium path today. */
export function desktopOsForTarget(os: ProfileOsTarget): OsFamily | null {
  if (os === 'windows' || os === 'linux') return os;
  if (os === 'macos' || os === 'macos_intel' || os === 'macos_arm') return 'macos';
  return null;
}

export function archForTarget(os: ProfileOsTarget): CpuArch | undefined {
  if (os === 'macos_arm') return 'arm64';
  if (os === 'macos_intel') return 'x86_64';
  return undefined;
}

export function isAndroidTarget(os: ProfileOsTarget): boolean {
  return os === 'android';
}

/** Short label for an engine value (falls back to the raw value if unknown). */
export function engineLabel(engine: EngineKind): string {
  return ENGINE_OPTIONS.find((o) => o.value === engine)?.label ?? engine;
}

/** Short label for an OS value. */
export function osLabel(os: ProfileOsTarget): string {
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
