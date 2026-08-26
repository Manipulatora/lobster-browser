/**
 * What the download page offers, and where the bytes actually come from.
 *
 * SERVED FROM OUR OWN HOST, NOT GITHUB. The installers used to be GitHub Release assets, which put
 * `github.com/...` in front of every prospective customer at the exact moment they decide to
 * install — it names the source repository, ties the product's availability to a third party's
 * policy on large binaries, and reads as a hobby project rather than a product. They are now served
 * from lobrowser.com/download/<file>, alongside the page that offers them, so the whole flow stays
 * on one origin.
 *
 * Still public and still credential-free: that is what lets an unauthenticated machine install, and
 * what lets an antivirus vendor or a mirror fetch a copy to scan. nginx serves them straight from
 * disk (see deploy/nginx/lobster-site.conf), so there is no API hop in the path.
 *
 * ONE VERSION, DERIVED EVERYWHERE. `RELEASE_VERSION` is the only value that moves between
 * releases: the tag, both installer file names and both URLs are built from it. They used to be
 * written out by hand, which made a half-done bump not just possible but likely - bumping the tag
 * and leaving `Lobster-Browser-Setup-1.0.0-x64.exe` behind yields a well-formed URL into the new
 * release that 404s, and that is exactly the broken-download failure `published` and the spec exist
 * to prevent. Flipping `published` stays manual, because only a human knows the asset is uploaded.
 *
 * Stated rather than fetched, so the page renders identically on the server (it is prerendered) and
 * on the client, and so a GitHub API outage cannot blank the one page whose whole job is handing
 * someone an installer.
 */

/** Product version shown to the user. Matches the Tauri package version. The ONLY thing to bump. */
export const RELEASE_VERSION = '1.0.0';

/** The Chromium milestone the bundled engine is built from, shown so support can match reports. */
export const ENGINE_VERSION = '152.0.7977.42';

/**
 * Public origin for both the page and the artifacts. Absolute rather than a bare `/download/` path
 * because this page is PRERENDERED and is also read by people who arrive at a mirror or a cached
 * copy; a relative URL there would resolve against the wrong host.
 */
export const DOWNLOAD_BASE = 'https://lobrowser.com/download';

const WINDOWS_INSTALLER = `Lobster-Browser-Setup-${RELEASE_VERSION}-x64.exe`;
const LINUX_INSTALLER = `lobster-browser_${RELEASE_VERSION}_amd64.deb`;

export type PlatformId = 'windows' | 'linux';

export interface DownloadArtifact {
  readonly platform: PlatformId;
  /** Shown under the icon, e.g. "Windows". */
  readonly name: string;
  /** Installer file name, also the last path segment of `url`. */
  readonly file: string;
  readonly url: string;
  /**
   * Human size, e.g. "29.3 MB". Release bookkeeping, not page copy: the page shows an icon, a name
   * and a button and nothing else, but a published row with no size means the entry was flipped on
   * before the asset was real, which the spec fails on.
   */
  readonly size: string;
  /**
   * False until the asset actually exists on the release. The box then shows a disabled control
   * rather than a link to a 404 — a download button that fails is worse than an honest gap.
   */
  readonly published: boolean;
}

export const DOWNLOADS: readonly DownloadArtifact[] = [
  {
    platform: 'windows',
    name: 'Windows',
    file: WINDOWS_INSTALLER,
    url: `${DOWNLOAD_BASE}/${WINDOWS_INSTALLER}`,
    size: '29.3 MB',
    published: true,
  },
  {
    platform: 'linux',
    name: 'Linux',
    file: LINUX_INSTALLER,
    url: `${DOWNLOAD_BASE}/${LINUX_INSTALLER}`,
    size: '159 MB',
    published: true,
  },
];

/**
 * Best guess at the visitor's platform, used only to sort their box first.
 *
 * Deliberately never HIDES the other platform: people download the Windows installer from a Linux
 * laptop to put on a USB stick, and a wrong guess that hides the box they wanted is worse than no
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
