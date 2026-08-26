import { describe, expect, it } from 'vitest';

import {
  DOWNLOAD_BASE,
  DOWNLOADS,
  RELEASE_VERSION,
  detectPlatform,
  orderedForPlatform,
} from './downloads.catalog';

describe('downloads catalog', () => {
  it('offers exactly the platforms the product ships, each with a resolvable URL', () => {
    expect(DOWNLOADS.map((d) => d.platform).sort()).toEqual(['linux', 'windows']);
    for (const item of DOWNLOADS) {
      // The URL must end in the same file name the box saves as, or the `download` attribute names
      // one installer while the release serves another.
      expect(item.url.endsWith(`/${item.file}`)).toBe(true);
      // Served from our own origin. A github.com URL here is the regression this asserts against:
      // it puts a third party in front of the customer at the moment they install.
      expect(item.url.startsWith(`${DOWNLOAD_BASE}/`)).toBe(true);
      expect(item.url.startsWith('https://')).toBe(true);
      // The version has to survive into the file name, or a release bump serves the old installer
      // from a well-formed new URL.
      expect(item.file).toContain(RELEASE_VERSION);
    }
  });

  it('never advertises a download whose artifact is not published', () => {
    // The failure this prevents: flipping `published` on release day before the asset is actually
    // on the release, so the box offers a button that 404s.
    for (const item of DOWNLOADS) {
      if (item.published) {
        expect(item.size, `${item.platform} is published without a size`).not.toBe('');
      }
    }
  });

  it('detects the visitor platform without mistaking Android for Linux', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    // Android matches /linux/ in its UA; offering it a .deb would be nonsense.
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 10; K)')).toBe(null);
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(null);
  });

  it('puts the visitor platform first but never hides the other one', () => {
    const ordered = orderedForPlatform('linux');
    expect(ordered[0]?.platform).toBe('linux');
    // People download the Windows installer from Linux to put it on a stick.
    expect(ordered).toHaveLength(DOWNLOADS.length);
    expect(orderedForPlatform(null)).toHaveLength(DOWNLOADS.length);
  });
});
