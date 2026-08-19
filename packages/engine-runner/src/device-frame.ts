import type { ScreenFingerprint } from '@lobster/shared-types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type MobileFormFactor = 'phone' | 'tablet';

export interface DeviceFrameRatios {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface DeviceFrameGeometry {
  outerWidth: number;
  outerHeight: number;
  windowX: number;
  windowY: number;
  visualScale: number;
  ratios: DeviceFrameRatios;
}

// Native Chromium paints a very thin rectangle rather than loading device artwork.
export const DEVICE_FRAME_BORDER: Readonly<Record<MobileFormFactor, number>> = {
  phone: 2,
  tablet: 2,
};

// Margin between the device shell and the browser content area. MUST match kStagePadding in the native
// lobium_device_frame_view.cc so the sidecar-computed fit scale and the native aperture agree exactly.
const STAGE_PADDING = 16;

// Conservative estimate of the vertical browser chrome above the web content area (tab strip + omnibox
// + bookmarks bar + title bar). This provides a safe launch-time bootstrap scale; native BrowserView then
// computes the exact fit from its real content bounds and synchronizes that image scale to emulation.
const BROWSER_CHROME_HEIGHT = 150;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function desktopWorkAreaFromEnv(): { width: number; height: number } {
  return {
    width: positiveInt(process.env.LOBSTER_DESKTOP_WIDTH, 1920),
    height: positiveInt(process.env.LOBSTER_DESKTOP_HEIGHT, 1080),
  };
}

let detectedDesktopWorkArea: Promise<{ width: number; height: number }> | undefined;

/**
 * Measure the desktop the device stage has to fit into.
 *
 * `xrandr` only exists under X11, so on Windows it fails and the phone window used to be centered
 * against a hardcoded 1920x1080 — wrong on every laptop and every 4K desk. Windows reports the
 * taskbar-excluded work area through WinForms, which needs no native dependency, and the query runs
 * at most once per sidecar process.
 */
async function measureDesktopWorkArea(): Promise<{ width: number; height: number }> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; ' +
          '$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; ' +
          '"$($area.Width)x$($area.Height)"',
      ],
      { env: process.env, timeout: 5000, windowsHide: true },
    );
    const match = /(\d+)\s*x\s*(\d+)/.exec(stdout);
    if (!match) return desktopWorkAreaFromEnv();
    return { width: positiveInt(match[1], 1920), height: positiveInt(match[2], 1080) };
  }
  const { stdout } = await execFileAsync('xrandr', ['--current'], {
    env: process.env,
    timeout: 1500,
  });
  const match = /current\s+(\d+)\s+x\s+(\d+)/i.exec(stdout);
  if (!match) return desktopWorkAreaFromEnv();
  return { width: positiveInt(match[1], 1920), height: positiveInt(match[2], 1080) };
}

/** Resolve the real desktop work area once per sidecar process, with deterministic env/fallback paths. */
export function resolveDesktopWorkArea(): Promise<{ width: number; height: number }> {
  if (process.env.LOBSTER_DESKTOP_WIDTH || process.env.LOBSTER_DESKTOP_HEIGHT) {
    return Promise.resolve(desktopWorkAreaFromEnv());
  }
  detectedDesktopWorkArea ??= measureDesktopWorkArea().catch(() => desktopWorkAreaFromEnv());
  return detectedDesktopWorkArea;
}

/** Estimate the native in-content frame's initial scale for the current desktop work area. */
export function deviceFrameGeometry(
  screen: Pick<ScreenFingerprint, 'width' | 'height'>,
  formFactor: MobileFormFactor,
  desktop = desktopWorkAreaFromEnv(),
): DeviceFrameGeometry {
  const border = DEVICE_FRAME_BORDER[formFactor];
  const unscaledOuterWidth = screen.width + border * 2;
  const unscaledOuterHeight = screen.height + border * 2;
  // Fit the device shell into the estimated browser CONTENT area. This is the safe bootstrap passed to
  // renderer emulation; native BrowserView replaces it with the exact live fit once layout is available.
  const availableWidth = Math.max(1, desktop.width - STAGE_PADDING * 2);
  const availableHeight = Math.max(1, desktop.height - BROWSER_CHROME_HEIGHT - STAGE_PADDING * 2);
  const visualScale = Math.min(
    1,
    availableWidth / unscaledOuterWidth,
    availableHeight / unscaledOuterHeight,
  );
  const outerWidth = Math.max(320, Math.round(unscaledOuterWidth * visualScale));
  const outerHeight = Math.max(320, Math.round(unscaledOuterHeight * visualScale));
  const ratios = {
    left: border / unscaledOuterWidth,
    right: border / unscaledOuterWidth,
    top: border / unscaledOuterHeight,
    bottom: border / unscaledOuterHeight,
  };
  return {
    outerWidth,
    outerHeight,
    windowX: Math.max(0, Math.round((desktop.width - outerWidth) / 2)),
    windowY: Math.max(0, Math.round((desktop.height - outerHeight) / 2)),
    visualScale,
    ratios,
  };
}

/** Scale for a resized stage; native layout letterboxes shapes that do not match the device. */
export function deviceFrameScaleForWindow(
  outerWidth: number,
  outerHeight: number,
  screen: Pick<ScreenFingerprint, 'width' | 'height'>,
  formFactor: MobileFormFactor,
): number {
  const border = DEVICE_FRAME_BORDER[formFactor];
  return Math.max(
    0.25,
    Math.min(
      3,
      outerWidth / (screen.width + border * 2),
      outerHeight / (screen.height + border * 2),
    ),
  );
}
