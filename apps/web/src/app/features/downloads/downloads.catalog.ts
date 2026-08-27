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
 * on the client, and so an API outage cannot blank the one page whose whole job is handing someone
 * an installer.
 *
 * DEPLOY ORDER MATTERS. The artifacts are uploaded to the server BEFORE this page is deployed.
 * Publishing the page first points every visitor at a 404, and the `published` flag below is the
 * only thing standing between a release and exactly that.
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

// The exact names the packagers emit, so publishing is a copy and never a rename. One of these used
// to read `Lobster-Browser-Setup-${RELEASE_VERSION}-x64.exe`, which matched nothing any build
// produced - every release needed a manual rename on the server, and forgetting it serves a 404 from
// a well-formed URL, which is the failure `published` exists to prevent.
const WINDOWS_BUNDLED = `Lobster-Browser-${RELEASE_VERSION}-x64-setup.exe`;
const WINDOWS_WEB = `Lobster-Browser-${RELEASE_VERSION}-x64-web-setup.exe`;
const LINUX_BUNDLED = `lobster-browser_${RELEASE_VERSION}_amd64.deb`;
const LINUX_WEB = `lobster-browser_${RELEASE_VERSION}_amd64-web.deb`;

export type PlatformId = 'windows' | 'linux';

/**
 * Which of the two builds this is.
 *
 * They differ in ONE thing: whether the ~260 MB browser engine rides inside the installer. The total
 * bytes are the same either way, so this is not a size choice but a WHEN choice - download it all up
 * front, or download a small installer and let the app fetch the engine on first run.
 *
 * `bundled` is offered first because the engine fetch is the slower half for most people: it comes
 * from one origin with no CDN in front of it, and a bad route makes it minutes. `web` stays for the
 * cases bundling is wrong for - a metered connection, a machine that already has the engine, or
 * anyone who would rather not pull 300 MB through a browser.
 */
export type DownloadVariant = 'bundled' | 'web';

export interface DownloadArtifact {
  readonly platform: PlatformId;
  /** Shown under the icon, e.g. "Windows". */
  readonly name: string;
  readonly variant: DownloadVariant;
  /** The one-word difference, shown on the button so the choice needs no paragraph. */
  readonly label: string;
  /** Installer file name, also the last path segment of `url`. */
  readonly file: string;
  readonly url: string;
  /**
   * Human size, e.g. "29.3 MB". Release bookkeeping AND page copy here: with two buttons per
   * platform the size IS the explanation of the difference, which is why neither needs a sentence.
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
    variant: 'bundled',
    label: 'Download',
    file: WINDOWS_BUNDLED,
    url: `${DOWNLOAD_BASE}/${WINDOWS_BUNDLED}`,
    size: '',
    published: false,
  },
  {
    platform: 'windows',
    name: 'Windows',
    variant: 'web',
    label: 'Web installer',
    file: WINDOWS_WEB,
    url: `${DOWNLOAD_BASE}/${WINDOWS_WEB}`,
    size: '29.3 MB',
    published: true,
  },
  {
    platform: 'linux',
    name: 'Linux',
    variant: 'bundled',
    label: 'Download',
    file: LINUX_BUNDLED,
    url: `${DOWNLOAD_BASE}/${LINUX_BUNDLED}`,
    size: '330 MB',
    published: true,
  },
  {
    platform: 'linux',
    name: 'Linux',
    variant: 'web',
    label: 'Web installer',
    file: LINUX_WEB,
    url: `${DOWNLOAD_BASE}/${LINUX_WEB}`,
    size: '56 MB',
    published: true,
  },
];

/** The two builds for one platform, bundled first. */
export function variantsFor(
  platform: PlatformId,
  items: readonly DownloadArtifact[] = DOWNLOADS,
): readonly DownloadArtifact[] {
  return items.filter((item) => item.platform === platform);
}

/** Each platform once, in the order its boxes should appear. */
export function platformsOf(
  items: readonly DownloadArtifact[] = DOWNLOADS,
): readonly PlatformId[] {
  return [...new Set(items.map((item) => item.platform))];
}

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
