import type { OsFamily } from '@lobster/shared-types';

/**
 * The display model: which (CSS size, devicePixelRatio) pairs a real desktop can actually report.
 *
 * `screen.width/height` are CSS pixels, so they are the PANEL divided by the OS scale factor — the two
 * are not independent. A persona that states 1920x1080 with dpr 1.5 claims a 2880x1620 panel; one that
 * states 1536x864 with dpr 1 claims a panel that has never been manufactured (1536x864 only exists as
 * 1080p at 125%). Both are single-read tells, and `window.devicePixelRatio` is one of the first values
 * every detector collects, so the pair has to come from a real panel and a real scale step.
 *
 * Windows exposes scaling in 25% steps, GNOME/KDE fractional scaling in 25% steps up to 200%, and macOS
 * reports 1 on a standard display or 2 on Retina — including its "looks like" scaled modes, where the
 * CSS size is NOT the panel halved (a 3024x1964 MacBook Pro reports 1512x982 by default but 1352x878 or
 * 1800x1169 when scaled). Those are enumerated from Apple's own mode list rather than computed.
 */
export interface DisplayMode {
  width: number;
  height: number;
  dpr: number;
}

/**
 * Scale steps each OS actually offers. Windows Settings goes to 350% for accessibility but stops
 * offering steps above 300% on the panels we model; GNOME's fractional list ends at 200%; macOS has
 * no fractional backing scale at all — it is 1 or 2, with everything else expressed as a scaled mode.
 */
const OS_DPR_LADDER: Record<OsFamily, readonly number[]> = {
  windows: [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3],
  linux: [1, 1.25, 1.5, 1.75, 2],
  macos: [1, 2],
};

/**
 * Panels shipped on PCs and desktop monitors, as physical pixels. Sourced from the StatCounter desktop
 * resolution table plus the laptop panels behind the scaled sizes it reports (1536x864 is 1080p at
 * 125%, 1280x720 is 1080p at 150%), so every mode this module admits traces back to hardware.
 */
const PC_PANELS: readonly (readonly [number, number])[] = [
  [1280, 720],
  [1280, 800],
  [1280, 1024],
  [1360, 768],
  [1366, 768],
  [1440, 900],
  [1600, 900],
  [1600, 1200],
  [1680, 1050],
  [1920, 1080],
  [1920, 1200],
  [2048, 1152],
  [2160, 1440],
  [2240, 1400],
  [2256, 1504],
  [2560, 1080],
  [2560, 1440],
  [2560, 1600],
  [2880, 1620],
  [2880, 1800],
  [3000, 2000],
  [3072, 1920],
  [3200, 1800],
  [3200, 2000],
  [3440, 1440],
  [3456, 2160],
  [3840, 1080],
  [3840, 1600],
  [3840, 2160],
  [3840, 2400],
  [5120, 1440],
  [5120, 2160],
  [5120, 2880],
];

/** Below this a desktop persona stops being a desktop; scaled modes that land here are dropped. */
const MIN_LOGICAL_WIDTH = 1024;
const MIN_LOGICAL_HEIGHT = 600;

/**
 * Apple's Retina modes, as CSS sizes at dpr 2 — the default plus the "More Space"/"Larger Text" steps
 * macOS offers for each built-in panel, and the common external displays (4K at "looks like 1920x1080",
 * 5K Studio Display, Pro Display XDR). A Retina Mac reports one of these; it never reports the panel
 * itself at dpr 2, which is why this list is enumerated instead of derived from panel/2.
 */
const MACOS_RETINA_LOGICAL: readonly (readonly [number, number])[] = [
  [1280, 800],
  [1280, 832],
  [1352, 878],
  [1440, 900],
  [1440, 932],
  [1470, 956],
  [1496, 967],
  [1512, 982],
  [1536, 960],
  [1680, 1050],
  [1680, 1092],
  [1710, 1112],
  [1728, 1117],
  [1792, 1120],
  [1800, 1169],
  [1920, 1080],
  [1920, 1200],
  [2048, 1152],
  [2056, 1329],
  [2240, 1260],
  [2364, 1528],
  [2560, 1440],
  [3008, 1692],
];

function mode(width: number, height: number, dpr: number): DisplayMode {
  return { width, height, dpr };
}

/** Every Retina mode a Mac can present, at the dpr 2 that always accompanies it. */
export const MACOS_RETINA_MODES: readonly DisplayMode[] = MACOS_RETINA_LOGICAL.map(([w, h]) =>
  mode(w, h, 2),
);

/**
 * Retina modes of the Intel MacBooks whose GPUs are still in the catalog (2016–2020 13"/15"/16"), kept
 * apart from the Apple-Silicon list so an Intel persona cannot land on a panel that only ever shipped
 * with an M-series chip, and vice versa.
 */
export const MACOS_INTEL_MODES: readonly DisplayMode[] = [
  mode(1280, 800, 2),
  mode(1440, 900, 2),
  mode(1536, 960, 2),
  mode(1680, 1050, 2),
  mode(1792, 1120, 2),
  mode(1920, 1200, 2),
];

/** Default and scaled modes of the Apple-Silicon MacBook Air/Pro, iMac 24" and Studio Display. */
export const MACOS_APPLE_SILICON_MODES: readonly DisplayMode[] = [
  mode(1280, 832, 2),
  mode(1352, 878, 2),
  mode(1440, 932, 2),
  mode(1470, 956, 2),
  mode(1496, 967, 2),
  mode(1512, 982, 2),
  mode(1710, 1112, 2),
  mode(1728, 1117, 2),
  mode(1800, 1169, 2),
  mode(2056, 1329, 2),
  mode(2240, 1260, 2),
  mode(2560, 1440, 2),
];

function pcModes(os: 'windows' | 'linux'): DisplayMode[] {
  const seen = new Set<string>();
  const modes: DisplayMode[] = [];
  for (const [panelWidth, panelHeight] of PC_PANELS) {
    for (const dpr of OS_DPR_LADDER[os]) {
      // Chromium reports the CSS size rounded, not truncated: 2560 at 150% reads 1707, not 1706.
      const width = Math.round(panelWidth / dpr);
      const height = Math.round(panelHeight / dpr);
      if (width < MIN_LOGICAL_WIDTH || height < MIN_LOGICAL_HEIGHT) continue;
      const key = `${width}x${height}@${dpr}`;
      if (seen.has(key)) continue;
      seen.add(key);
      modes.push(mode(width, height, dpr));
    }
  }
  return modes;
}

const WINDOWS_MODES = pcModes('windows');
const LINUX_MODES = pcModes('linux');

/**
 * Every (CSS size, dpr) pair the given OS can present. The profile UI renders this as its screen +
 * scaling choice, and derivation draws from curated subsets of it, so a hand-picked screen and a
 * seed-derived one are drawn from the same reality.
 */
export function displayModesFor(os: OsFamily): readonly DisplayMode[] {
  if (os === 'macos') return MACOS_RETINA_MODES;
  return os === 'linux' ? LINUX_MODES : WINDOWS_MODES;
}

function sameMode(a: DisplayMode, b: DisplayMode): boolean {
  // A rounded CSS size can legitimately be off by a pixel from ours (Chromium rounds the panel/scale
  // division per axis, and panel tables disagree by a pixel on a few laptop displays).
  return Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1 && a.dpr === b.dpr;
}

/**
 * Is this CSS size + devicePixelRatio a pair a real display produces?
 *
 * At dpr 1 the CSS size IS the panel, and any panel can be driven at a non-native mode (or by a VM, or
 * by an ultrawide we have not tabulated), so only the ratio itself is checked. Above 1 the pair asserts
 * a specific panel AND a specific scale step, which is where impossible combinations appear, so the
 * exact mode must exist.
 */
export function isPlausibleDisplayMode(os: OsFamily, candidate: DisplayMode): boolean {
  if (!OS_DPR_LADDER[os].includes(candidate.dpr)) return false;
  if (candidate.dpr === 1) return true;
  return displayModesFor(os).some((known) => sameMode(known, candidate));
}

/**
 * Snap a measured devicePixelRatio onto the OS's scale ladder. A host capture reads
 * `window.devicePixelRatio`, which folds in the page zoom of whatever tab probed it — so a capture
 * taken at 110% zoom would otherwise persist a ratio no display setting produces.
 */
export function normalizeDevicePixelRatio(os: OsFamily, dpr: number): number {
  const ladder = OS_DPR_LADDER[os];
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  let best = ladder[0] as number;
  for (const step of ladder) {
    if (Math.abs(step - dpr) < Math.abs(best - dpr)) best = step;
  }
  return best;
}
