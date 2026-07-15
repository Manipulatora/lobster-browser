import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVICE_FRAME_BORDER,
  desktopWorkAreaFromEnv,
  deviceFrameGeometry,
  deviceFrameScaleForWindow,
} from './device-frame.js';

test('native device shell uses a very thin border for both form factors', () => {
  assert.deepEqual(DEVICE_FRAME_BORDER, { phone: 2, tablet: 2 });
});

test('phone frame is portrait, centered, and scaled to fit a short desktop', () => {
  const geometry = deviceFrameGeometry({ width: 393, height: 873 }, 'phone', {
    width: 1280,
    height: 832,
  });
  assert.ok(geometry.outerHeight > geometry.outerWidth);
  assert.ok(geometry.outerHeight <= 832 * 0.88 + 1);
  assert.equal(geometry.windowX, Math.round((1280 - geometry.outerWidth) / 2));
  assert.equal(geometry.windowY, Math.round((832 - geometry.outerHeight) / 2));
  assert.ok(geometry.visualScale < 1);
});

test('explicit desktop work-area env is honored', () => {
  const previousWidth = process.env.LOBSTER_DESKTOP_WIDTH;
  const previousHeight = process.env.LOBSTER_DESKTOP_HEIGHT;
  try {
    process.env.LOBSTER_DESKTOP_WIDTH = '1600';
    process.env.LOBSTER_DESKTOP_HEIGHT = '826';
    assert.deepEqual(desktopWorkAreaFromEnv(), { width: 1600, height: 826 });
  } finally {
    if (previousWidth === undefined) delete process.env.LOBSTER_DESKTOP_WIDTH;
    else process.env.LOBSTER_DESKTOP_WIDTH = previousWidth;
    if (previousHeight === undefined) delete process.env.LOBSTER_DESKTOP_HEIGHT;
    else process.env.LOBSTER_DESKTOP_HEIGHT = previousHeight;
  }
});

test('tablet frame is landscape and centered', () => {
  const geometry = deviceFrameGeometry({ width: 873, height: 393 }, 'tablet', {
    width: 1920,
    height: 1080,
  });
  assert.ok(geometry.outerWidth > geometry.outerHeight);
  assert.equal(geometry.windowX, Math.round((1920 - geometry.outerWidth) / 2));
  assert.equal(geometry.windowY, Math.round((1080 - geometry.outerHeight) / 2));
  assert.equal(geometry.visualScale, 1);
});

test('resizing a shell changes visual zoom without changing the configured CSS screen', () => {
  const screen = { width: 393, height: 873 };
  const initial = deviceFrameGeometry(screen, 'phone', { width: 1920, height: 1080 });
  const baseScale = deviceFrameScaleForWindow(
    initial.outerWidth,
    initial.outerHeight,
    screen,
    'phone',
  );
  const zoomed = deviceFrameScaleForWindow(
    initial.outerWidth * 1.25,
    initial.outerHeight * 1.25,
    screen,
    'phone',
  );
  assert.ok(Math.abs(baseScale - initial.visualScale) < 0.01);
  assert.ok(zoomed > baseScale);
});
