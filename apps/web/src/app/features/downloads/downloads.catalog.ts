/**
 * What the account's Downloads page offers, and where the bytes actually come from.
 *
 * THE ARTIFACTS ARE PUBLIC, THE PAGE IS NOT. Installers are published as GitHub Release assets on a
 * public repository, so the URLs below need no credential — which is what makes them installable by
 * a machine that is not signed in, and what lets an antivirus vendor or a mirror fetch them. The
 * PAGE is behind `authGuard` because that is where the account context lives (which build you are
 * entitled to, your licence state), not because the file is a secret. Pretending otherwise by
 * proxying the download through the API would buy nothing and cost every user a slow hop.
 *
 * ONE PLACE TO EDIT ON RELEASE. `RELEASE_TAG` and the per-platform `size`/`sha256` are the only
 * things that move between releases. They are stated rather than fetched so the page renders
 * identically on the server (SSR) and the client, and so a GitHub API outage cannot blank the one
 * page whose whole job is handing someone an installer.
 */

/** The GitHub release these artifacts belong to. Bump on every product release. */
export const RELEASE_TAG = 'v1.0.0';

/** Product version shown to the user. Matches the Tauri package version. */
export const RELEASE_VERSION = '1.0.0';

/** The Chromium milestone the bundled engine is built from, shown so support can match reports. */
export const ENGINE_VERSION = '152.0.7977.42';

const RELEASE_BASE = `https://github.com/Manipulatora/lobster-browser/releases/download/${RELEASE_TAG}`;

export type PlatformId = 'windows' | 'linux';

export interface DownloadArtifact {
  readonly platform: PlatformId;
  /** Shown as the card heading. */
  readonly name: string;
  /** e.g. "Windows 10 and 11 · 64-bit". */
  readonly requirement: string;
  /** Installer file name, also the last path segment of `url`. */
  readonly file: string;
  readonly url: string;
  /** Human size, e.g. "94 MB". Empty string when the artifact is not published yet. */
  readonly size: string;
  /** Lowercase hex SHA-256 of the installer, for anyone who wants to verify it. */
  readonly sha256: string;
  /** Shell one-liner that checks the hash on that platform. */
  readonly verifyCommand: string;
  /**
   * False until the asset actually exists on the release. The card then renders as "coming soon"
   * rather than as a link to a 404 — a download button that fails is worse than an honest gap.
   */
  readonly published: boolean;
  /** Anything the user must know BEFORE clicking, e.g. an unsigned installer warning. */
  readonly notice?: string;
}

export const DOWNLOADS: readonly DownloadArtifact[] = [
  {
    platform: 'windows',
    name: 'Windows',
    requirement: 'Windows 10 or 11 · 64-bit',
    file: 'Lobster-Browser-Setup-1.0.0-x64.exe',
    url: `${RELEASE_BASE}/Lobster-Browser-Setup-1.0.0-x64.exe`,
    size: '29.3 MB',
    sha256: '2ef982236deb9aee3f2e1522576f481dea89147287fceb482e1f167f7ea80523',
    verifyCommand: 'Get-FileHash .\\Lobster-Browser-Setup-1.0.0-x64.exe -Algorithm SHA256',
    published: true,
    // Stated up front rather than discovered at the SmartScreen prompt. A user who is warned
    // expects the dialog; a user who is not assumes the download is malicious and stops.
    notice:
      'This installer is not yet code-signed, so Windows SmartScreen will show a warning. Choose “More info” then “Run anyway”. Verify the SHA-256 below if you want to be certain of what you have.',
  },
  {
    platform: 'linux',
    name: 'Linux',
    requirement: 'Debian / Ubuntu · x86-64',
    file: 'lobster-browser_1.0.0_amd64.deb',
    url: `${RELEASE_BASE}/lobster-browser_1.0.0_amd64.deb`,
    size: '',
    sha256: '',
    verifyCommand: 'sha256sum lobster-browser_1.0.0_amd64.deb',
    published: false,
  },
];

/** True when nothing has been published yet, so the page can lead with one honest banner. */
export function noArtifactsPublished(items: readonly DownloadArtifact[] = DOWNLOADS): boolean {
  return items.every((item) => !item.published);
}

/**
 * Best guess at the visitor's platform, used only to sort their card first.
 *
 * Deliberately never HIDES the other platform: people download the Windows installer from a Linux
 * laptop to put on a USB stick, and a wrong guess that hides the card they wanted is worse than no
 * guess at all.
 */
export function detectPlatform(userAgent: string): PlatformId | null {
  if (/windows|win32|win64/i.test(userAgent)) return 'windows';
  if (/linux|x11|ubuntu|debian/i.test(userAgent) && !/android/i.test(userAgent)) return 'linux';
  return null;
}

/** The visitor's platform first, everything else in declared order. */
export function orderedForPlatform(
  platform: PlatformId | null,
  items: readonly DownloadArtifact[] = DOWNLOADS,
): readonly DownloadArtifact[] {
  if (!platform) return items;
  return [...items].sort((a, b) =>
    a.platform === platform ? -1 : b.platform === platform ? 1 : 0,
  );
}
