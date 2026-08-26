/**
 * Share one downloaded Widevine CDM across every profile on this machine.
 *
 * WHY. `enable_widevine` is compiled in, and Chromium's component updater fetches the CDM from
 * Google into the profile that asked for it. But CdmRegistry reads CDMs at BROWSER STARTUP, so a
 * brand-new profile downloads the CDM mid-session and cannot use it until its next launch. Measured
 * on this build: run 1 of a fresh profile answers NotSupportedError with the CDM already on disk;
 * run 2 of the same profile resolves com.widevine.alpha and creates MediaKeys.
 *
 * That first-run gap is exactly the kind of difference an anti-detect product cannot afford: every
 * profile's FIRST session would fail a Widevine probe that its later sessions pass, and every real
 * Chrome passes always. Because each profile is its own `--user-data-dir`, the gap repeats per
 * profile rather than once per machine.
 *
 * WHAT THIS IS NOT. It does not download, modify or redistribute the CDM. third_party/widevine's
 * licence forbids distributing it, and we do not: Google's component updater puts it on the user's
 * machine, and this only copies it between that same user's own profile directories, exactly as
 * copying a file between two folders would.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Chromium's per-profile CDM directory name. */
const CDM_DIR = 'WidevineCdm';
/**
 * Written by the component updater beside the versioned directory. Despite the name it is a FILE,
 * and it holds an ABSOLUTE PATH to the CDM it points at:
 *
 *     {"Path":"/home/u/.../WidevineCdm/4.10.3050.0"}
 *
 * That is why a copied CDM cannot simply be dropped into another profile: the marker would still
 * name the directory it was copied FROM, and the browser would either load the donor's copy (if that
 * directory happens to still exist) or find nothing. This bit was found the hard way - a seeded
 * profile appeared to work only for as long as the donor profile it was copied from remained on
 * disk, and started failing the moment that temporary directory was cleaned up.
 */
const READY_MARKER = 'latest-component-updated-widevine-cdm';

/** Machine-wide cache, beside the engine runtime rather than inside any one profile. */
export function widevineCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.LOBSTER_WIDEVINE_CACHE;
  if (explicit) return explicit;
  const base =
    process.platform === 'win32'
      ? (env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
      : join(homedir(), '.local', 'share');
  return join(base, 'lobster', 'widevine');
}

function versionDirOf(dir: string): string | null {
  try {
    return readdirSync(dir).find((e) => /^\d+(\.\d+)+$/.test(e)) ?? null;
  } catch {
    return null;
  }
}

function looksUsable(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    const entries = readdirSync(dir);
    // A version directory, the updater's ready marker, and the library itself. A half-written
    // download, or a copy whose payload never arrived, fails at least one of the three.
    if (!entries.includes(READY_MARKER)) return false;
    const version = versionDirOf(dir);
    if (!version) return false;
    return readdirSync(join(dir, version)).includes('manifest.json');
  } catch {
    return false;
  }
}

/**
 * Point the ready marker at THIS copy of the CDM.
 *
 * Without it the marker still names the directory the CDM was copied from - see READY_MARKER. The
 * shape is preserved rather than rewritten wholesale so any field the updater adds later survives.
 */
function repointMarker(cdmDir: string): boolean {
  const version = versionDirOf(cdmDir);
  if (!version) return false;
  const marker = join(cdmDir, READY_MARKER);
  try {
    let doc: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(marker, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      }
    } catch {
      /* unreadable or not JSON: write a fresh document rather than propagate a broken one */
    }
    doc.Path = join(cdmDir, version);
    writeFileSync(marker, JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the cached CDM into a profile that has none, BEFORE the browser starts.
 *
 * Silent and best-effort by design: Widevine is a realism surface, not a launch requirement, and a
 * profile that fails to receive it still launches and still downloads its own copy.
 */
export function seedWidevineFromCache(userDataDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const cache = widevineCacheDir(env);
  if (!looksUsable(cache)) return false;
  const target = join(userDataDir, CDM_DIR);
  if (existsSync(target)) return false;
  try {
    mkdirSync(userDataDir, { recursive: true });
    cpSync(cache, target, { recursive: true });
    // The marker still names the profile this CDM was captured from; without repointing it the
    // browser loads that profile's copy when it still exists and nothing when it does not.
    if (!repointMarker(target)) {
      rmSync(target, { recursive: true, force: true });
      return false;
    }
    return true;
  } catch {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      /* leave it; the browser will re-download into a fresh directory */
    }
    return false;
  }
}

/**
 * Populate the machine cache from the first profile that finished a download.
 *
 * Called after a session ends rather than during it, so the CDM being copied is complete: the ready
 * marker is written last by the updater, and `looksUsable` requires it.
 */
export function captureWidevineToCache(userDataDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const source = join(userDataDir, CDM_DIR);
  if (!looksUsable(source)) return false;
  const cache = widevineCacheDir(env);
  if (looksUsable(cache)) return false;
  try {
    mkdirSync(cache, { recursive: true });
    cpSync(source, cache, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
