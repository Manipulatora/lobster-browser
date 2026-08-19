import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname } from 'node:path';
import { signalProcessTree } from './process-tree.js';

export interface AndroidMirrorOptions {
  serial: string;
  profileName?: string;
  width: number;
  height: number;
  desktopWidth?: number;
  desktopHeight?: number;
  executablePath?: string;
}

export interface AndroidMirrorHandle {
  close(): Promise<void>;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Build an interactive, centered scrcpy window matching the profile's CSS screen aspect/size. */
export function buildAndroidMirrorArgs(opts: AndroidMirrorOptions): string[] {
  const desktopWidth = opts.desktopWidth ?? positiveInt(process.env.LOBSTER_DESKTOP_WIDTH, 1280);
  const desktopHeight = opts.desktopHeight ?? positiveInt(process.env.LOBSTER_DESKTOP_HEIGHT, 832);
  const width = Math.max(320, Math.min(Math.round(opts.width), Math.floor(desktopWidth * 0.9)));
  const height = Math.max(480, Math.min(Math.round(opts.height), Math.floor(desktopHeight * 0.9)));
  const x = Math.max(0, Math.floor((desktopWidth - width) / 2));
  const y = Math.max(0, Math.floor((desktopHeight - height) / 2));
  const title = `${opts.profileName?.trim() || 'Android profile'} — Lobium`;
  return [
    '--serial',
    opts.serial,
    '--window-title',
    title,
    '--window-width',
    String(width),
    '--window-height',
    String(height),
    '--window-x',
    String(x),
    '--window-y',
    String(y),
    '--stay-awake',
    '--disable-screensaver',
  ];
}

function waitForSpawn(child: ChildProcess, executable: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      child.off('spawn', onSpawn);
      reject(
        new Error(
          `cannot start Android device mirror (${basename(executable)}): ${error.message}. ` +
            'Install scrcpy or set LOBSTER_SCRCPY_BIN.',
        ),
      );
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

export async function launchAndroidMirror(
  opts: AndroidMirrorOptions,
): Promise<AndroidMirrorHandle> {
  const executable = opts.executablePath ?? process.env.LOBSTER_SCRCPY_BIN ?? 'scrcpy';
  // A bare name is resolved from PATH by the OS; only a configured path is ours to pre-check. Windows
  // separates with a backslash, so `dirname` is what distinguishes the two on both platforms.
  if (dirname(executable) !== '.') await access(executable, constants.X_OK);
  const child = spawn(executable, buildAndroidMirrorArgs(opts), {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
    windowsHide: false,
  });
  await waitForSpawn(child, executable);
  return {
    close: async () => {
      if (child.exitCode !== null || child.killed) return;
      // scrcpy runs its own adb server/tunnel children, which outlive a kill aimed at scrcpy alone.
      signalProcessTree(child, 'SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) signalProcessTree(child, 'SIGKILL');
          resolve();
        }, 1500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
