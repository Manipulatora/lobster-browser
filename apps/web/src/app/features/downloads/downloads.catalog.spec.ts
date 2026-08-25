import { describe, expect, it } from 'vitest';

import {
  DOWNLOADS,
  RELEASE_TAG,
  detectPlatform,
  noArtifactsPublished,
  orderedForPlatform,
} from './downloads.catalog';

describe('downloads catalog', () => {
  it('offers exactly the platforms the product ships, each with a resolvable URL', () => {
    expect(DOWNLOADS.map((d) => d.platform).sort()).toEqual(['linux', 'windows']);
    for (const item of DOWNLOADS) {
      // The URL must end in the same file name the card shows, or "verify this SHA-256 of
      // <file>" describes a different file than the one the button fetches.
      expect(item.url.endsWith(`/${item.file}`)).toBe(true);
      expect(item.url).toContain(RELEASE_TAG);
      expect(item.url.startsWith('https://')).toBe(true);
    }
  });

  it('never advertises a download whose artifact is not published', () => {
    // The failure this prevents: flipping `published` on release day but forgetting the hash, so
    // the page offers a button and an empty integrity check.
    for (const item of DOWNLOADS) {
      if (item.published) {
        expect(item.sha256, `${item.platform} is published without a SHA-256`).toMatch(
          /^[0-9a-f]{64}$/,
        );
        expect(item.size, `${item.platform} is published without a size`).not.toBe('');
      }
    }
  });

  it('states the SmartScreen warning on Windows while the installer is unsigned', () => {
    const windows = DOWNLOADS.find((d) => d.platform === 'windows');
    expect(windows?.notice ?? '').toMatch(/SmartScreen/i);
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

  it('reports the pre-release state so the page can say so once, plainly', () => {
    expect(noArtifactsPublished([{ ...DOWNLOADS[0]!, published: false }])).toBe(true);
    expect(noArtifactsPublished([{ ...DOWNLOADS[0]!, published: true }])).toBe(false);
  });
});
