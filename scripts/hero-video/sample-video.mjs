import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const [inputPath, outputDirectory, ...rawTimes] = process.argv.slice(2);
if (!inputPath || !outputDirectory) {
  throw new Error(
    "Usage: node scripts/hero-video/sample-video.mjs INPUT OUTPUT_DIR [TIME_SECONDS ...]",
  );
}

const times = rawTimes.length ? rawTimes.map(Number) : [3, 9, 16, 20, 23, 27];
if (times.some((time) => !Number.isFinite(time))) {
  throw new Error("Every sample time must be a finite number.");
}

await fs.mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ["--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 1300 } });
  await page.goto(pathToFileURL(path.join(import.meta.dirname, "video-player.html")).href);
  const source = pathToFileURL(path.resolve(inputPath)).href;
  const metadata = await page.evaluate(async (videoSource) => {
    const video = document.querySelector("#clip");
    video.src = videoSource;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Video metadata timeout: ${video.error?.message ?? ""}`)),
        15000,
      );
      video.addEventListener(
        "loadedmetadata",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      video.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`Video error ${video.error?.code}: ${video.error?.message}`));
        },
        { once: true },
      );
      video.load();
    });
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
  }, source);
  console.log(JSON.stringify(metadata));

  for (let index = 0; index < times.length; index += 1) {
    const time = Math.min(Math.max(times[index], 0.04), metadata.duration - 0.06);
    await page.evaluate(async (seekTime) => {
      const video = document.querySelector("#clip");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Seek timeout at ${seekTime}`)), 15000);
        video.addEventListener(
          "seeked",
          () => {
            clearTimeout(timer);
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          },
          { once: true },
        );
        video.currentTime = seekTime;
      });
    }, time);
    await page.locator("#clip").screenshot({
      path: path.join(outputDirectory, `sample-${String(index).padStart(2, "0")}.png`),
    });
  }
} finally {
  await browser.close();
}
