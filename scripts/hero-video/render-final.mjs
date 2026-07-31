import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '../..');
const outputDirectory = path.resolve(
  process.env.LOBSTER_HERO_FRAMES ?? '/tmp/lobster-hero-v2/rendered-frames',
);
const openingPath = path.resolve(
  process.env.LOBSTER_HERO_OPENING ?? '/tmp/lobster-hero-v2/plates/opening-work-i2v-4k.mp4',
);
const businessPath = path.resolve(
  process.env.LOBSTER_HERO_BUSINESS ?? '/tmp/lobster-hero-v2/plates/multiple-businesses-i2v-4k.mp4',
);
const agentPath = path.resolve(
  process.env.LOBSTER_HERO_AGENT ?? '/tmp/lobster-hero-v2/plates/agentic-lobster-i2v-4k.mp4',
);

const fps = 30;
const totalFrames = 20 * fps;
const requestedFrames = process.argv.slice(2).flatMap((value) => {
  const range = value.match(/^(\d+):(\d+)$/);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start > end) throw new Error(`Invalid descending frame range: ${value}`);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }
  const frame = Number(value);
  return Number.isInteger(frame) ? [frame] : [];
});
const frames = requestedFrames.length
  ? requestedFrames
  : Array.from({ length: totalFrames }, (_, index) => index);

await fs.mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});

try {
  const page = await browser.newPage({
    viewport: { width: 1300, height: 1300 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(path.join(ROOT, 'scripts/hero-video/composite.html')).href);
  await page.evaluate(() => {
    window.seekVideo = async (video, time) => {
      const target = Math.min(Math.max(time, 0.04), Math.max(0.04, video.duration - 0.06));
      if (Math.abs(video.currentTime - target) < 0.012 && video.readyState >= 2) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Seek timeout at ${target.toFixed(3)}`)),
          12000,
        );
        video.addEventListener(
          'seeked',
          () => {
            clearTimeout(timer);
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          },
          { once: true },
        );
        video.currentTime = target;
      });
    };
  });
  await page.evaluate(
    async ({ opening, business, agent }) => {
      await window.configureAssets({ opening, business, agent });
    },
    {
      opening: pathToFileURL(openingPath).href,
      business: pathToFileURL(businessPath).href,
      agent: pathToFileURL(agentPath).href,
    },
  );

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    await page.evaluate(async (currentFrame) => {
      await window.renderFrame(currentFrame);
    }, frame);
    const filename = `frame-${String(frame).padStart(4, '0')}.png`;
    await page.screenshot({
      path: path.join(outputDirectory, filename),
      type: 'png',
      animations: 'disabled',
    });
    if (index === 0 || (index + 1) % 30 === 0 || index === frames.length - 1) {
      console.log(`RENDERED ${index + 1}/${frames.length} frame=${frame}`);
    }
  }
} finally {
  await browser.close();
}
