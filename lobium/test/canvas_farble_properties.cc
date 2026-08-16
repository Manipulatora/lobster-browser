// Property tests for lobium::FarbleCanvasRgba / FarbleCanvasRgbaSubRect / FarbleClientRect.
//
// Each test is a DETECTION ORACLE a page can run in a few lines, taken from docs/ENGINE_AUDIT.md.
// A failure here means the engine is distinguishable from honest Chrome.
//
// Run with lobium/test/run.ps1. No Chromium checkout required.

#include "components/lobium_fp/lobium_farble.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <random>
#include <vector>

namespace {

int g_failures = 0;

void Check(bool ok, const char* what) {
  std::printf("  %-64s %s\n", what, ok ? "ok" : "FAIL");
  if (!ok) {
    g_failures++;
  }
}

constexpr uint32_t kSeedA = 0xC0FFEEu;
constexpr uint32_t kSeedB = 0xBADF00Du;

// A simple RGBA8888 top-down image.
struct Image {
  int w = 0;
  int h = 0;
  std::vector<uint8_t> px;

  Image(int width, int height) : w(width), h(height), px(static_cast<size_t>(width) * height * 4) {}

  size_t Stride() const { return static_cast<size_t>(w) * 4u; }
  uint8_t* At(int x, int y) { return px.data() + static_cast<size_t>(y) * Stride() + static_cast<size_t>(x) * 4u; }
  const uint8_t* At(int x, int y) const {
    return px.data() + static_cast<size_t>(y) * Stride() + static_cast<size_t>(x) * 4u;
  }

  void Fill(int x0, int y0, int fw, int fh, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    for (int y = y0; y < y0 + fh; ++y) {
      for (int x = x0; x < x0 + fw; ++x) {
        uint8_t* p = At(x, y);
        p[0] = r; p[1] = g; p[2] = b; p[3] = a;
      }
    }
  }
};

// A "fingerprint scene": textured, every pixel differing from its neighbours, fully opaque —
// the anti-aliased/blended content a canvas fingerprint's entropy actually comes from.
Image Scene(int w, int h, uint32_t rng_seed) {
  Image img(w, h);
  std::mt19937 rng(rng_seed);
  std::uniform_int_distribution<int> d(0, 255);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      uint8_t* p = img.At(x, y);
      p[0] = static_cast<uint8_t>(d(rng));
      p[1] = static_cast<uint8_t>(d(rng));
      p[2] = static_cast<uint8_t>(d(rng));
      p[3] = 255;
    }
  }
  return img;
}

// Farble a sub-rectangle exactly the way the getImageData hook does: extract the rect into its own
// buffer, and hand the kernel a one-pixel apron clipped to the canvas.
Image ReadRect(const Image& canvas, int sx, int sy, int sw, int sh, uint32_t seed) {
  Image out(sw, sh);
  for (int y = 0; y < sh; ++y) {
    std::memcpy(out.At(0, y), canvas.At(sx, sy + y), static_cast<size_t>(sw) * 4u);
  }
  const int ax0 = sx > 0 ? sx - 1 : 0;
  const int ay0 = sy > 0 ? sy - 1 : 0;
  const int ax1 = sx + sw < canvas.w ? sx + sw + 1 : canvas.w;
  const int ay1 = sy + sh < canvas.h ? sy + sh + 1 : canvas.h;
  Image apron(ax1 - ax0, ay1 - ay0);
  for (int y = 0; y < apron.h; ++y) {
    std::memcpy(apron.At(0, y), canvas.At(ax0, ay0 + y), static_cast<size_t>(apron.w) * 4u);
  }
  lobium::FarbleCanvasRgbaSubRect(out.px.data(), sw, sh, out.Stride(), apron.px.data(), apron.w,
                                  apron.h, apron.Stride(), sx - ax0, sy - ay0, ax0, ay0, seed);
  return out;
}

}  // namespace

int main() {
  std::printf("lobium::FarbleCanvas*\n");

  // ORACLE: a known solid fill must read back byte-exact. This is the cheapest canvas tamper check
  // there is, and the one CreepJS reports as a canvas lie. The rule that protects it: a pixel is
  // perturbed only when it is byte-identical to NONE of its four orthogonal neighbours.
  {
    Image img(200, 100);
    img.Fill(0, 0, 200, 100, 0, 0, 0, 0);       // transparent background
    img.Fill(10, 10, 100, 50, 255, 102, 0, 255);  // #f60
    Image before = img;
    lobium::FarbleCanvasRgba(img.px.data(), img.w, img.h, img.Stride(), 0, 0, kSeedA);
    bool exact = true;
    for (int y = 10; y < 60; ++y) {
      for (int x = 10; x < 110; ++x) {
        exact = exact && std::memcmp(img.At(x, y), before.At(x, y), 4) == 0;
      }
    }
    Check(exact, "a solid fillRect reads back byte-exact, border included");
  }

  // ORACLE: a cleared canvas must be all zero.
  {
    Image img(64, 64);
    lobium::FarbleCanvasRgba(img.px.data(), img.w, img.h, img.Stride(), 0, 0, kSeedA);
    bool zero = true;
    for (uint8_t b : img.px) {
      zero = zero && (b == 0);
    }
    Check(zero, "a cleared (fully transparent) canvas stays all-zero");
  }

  // ORACLE: a hard edge between two solid fills is not an anti-aliased pixel and must survive.
  {
    Image img(64, 64);
    img.Fill(0, 0, 32, 64, 255, 0, 0, 255);
    img.Fill(32, 0, 32, 64, 0, 0, 255, 255);
    Image before = img;
    lobium::FarbleCanvasRgba(img.px.data(), img.w, img.h, img.Stride(), 0, 0, kSeedA);
    Check(std::memcmp(img.px.data(), before.px.data(), img.px.size()) == 0,
          "a hard edge between two solid fills is untouched");
  }

  // ORACLE, CRITICAL: the perturbation must not depend on the requested rectangle. A full read and
  // any sub-read must agree pixel for pixel — including a 1x1 read, which previously had no
  // neighbours of its own, was therefore always classified flat, and let a page recover the entire
  // pristine canvas one pixel at a time while proving tampering in two calls.
  {
    Image canvas = Scene(96, 48, 3);
    Image full = canvas;
    lobium::FarbleCanvasRgba(full.px.data(), full.w, full.h, full.Stride(), 0, 0, kSeedA);

    bool sub_agrees = true;
    Image sub = ReadRect(canvas, 40, 20, 16, 12, kSeedA);
    for (int y = 0; y < 12; ++y) {
      for (int x = 0; x < 16; ++x) {
        sub_agrees = sub_agrees && std::memcmp(sub.At(x, y), full.At(40 + x, 20 + y), 4) == 0;
      }
    }
    Check(sub_agrees, "a sub-rect read agrees with the full read, pixel for pixel");

    bool one_agrees = true;
    size_t recovered = 0;
    for (int y = 0; y < canvas.h; ++y) {
      for (int x = 0; x < canvas.w; ++x) {
        Image one = ReadRect(canvas, x, y, 1, 1, kSeedA);
        if (std::memcmp(one.At(0, 0), full.At(x, y), 4) != 0) {
          one_agrees = false;
        }
        if (std::memcmp(one.At(0, 0), canvas.At(x, y), 4) == 0) {
          recovered++;
        }
      }
    }
    Check(one_agrees, "a 1x1 read agrees with the full read (no pixel-at-a-time recovery)");
    std::printf("      1x1 reads returning the PRISTINE pixel: %zu/%d\n", recovered,
                canvas.w * canvas.h);
  }

  // ORACLE, CRITICAL: getImageData -> putImageData -> getImageData must be a fixed point. An
  // additive nudge gives b = v + 2d, so the page recovers the true pixel as 2a - b and proves
  // tampering at the same time.
  {
    Image canvas = Scene(80, 40, 5);
    Image once = canvas;
    lobium::FarbleCanvasRgba(once.px.data(), once.w, once.h, once.Stride(), 0, 0, kSeedA);
    Image twice = once;  // as if putImageData wrote `once` back
    lobium::FarbleCanvasRgba(twice.px.data(), twice.w, twice.h, twice.Stride(), 0, 0, kSeedA);
    Check(std::memcmp(once.px.data(), twice.px.data(), once.px.size()) == 0,
          "idempotent: the putImageData round trip is a fixed point");
  }

  // Entropy and per-profile behaviour on a real scene.
  {
    Image canvas = Scene(120, 60, 9);
    Image a = canvas, a2 = canvas, b = canvas;
    lobium::FarbleCanvasRgba(a.px.data(), a.w, a.h, a.Stride(), 0, 0, kSeedA);
    lobium::FarbleCanvasRgba(a2.px.data(), a2.w, a2.h, a2.Stride(), 0, 0, kSeedA);
    lobium::FarbleCanvasRgba(b.px.data(), b.w, b.h, b.Stride(), 0, 0, kSeedB);
    Check(std::memcmp(a.px.data(), a2.px.data(), a.px.size()) == 0, "stable for a given seed");
    Check(std::memcmp(a.px.data(), b.px.data(), a.px.size()) != 0, "distinct across seeds");
    Check(std::memcmp(a.px.data(), canvas.px.data(), a.px.size()) != 0, "differs from the host");

    size_t moved = 0;
    int max_delta = 0;
    for (size_t i = 0; i < canvas.px.size(); ++i) {
      if (a.px[i] != canvas.px[i]) {
        moved++;
      }
      max_delta = std::max(max_delta, std::abs(static_cast<int>(a.px[i]) - canvas.px[i]));
    }
    Check(max_delta <= 1, "never moves a channel by more than one 8-bit step");
    Check(moved > 0, "perturbs a textured scene");
    std::printf("      channels moved on a textured scene: %zu/%zu (%.1f%%)\n", moved,
                canvas.px.size(),
                100.0 * static_cast<double>(moved) / static_cast<double>(canvas.px.size()));
  }

  // Alpha is never touched: an opaque canvas must stay opaque.
  {
    Image canvas = Scene(64, 64, 21);
    Image a = canvas;
    lobium::FarbleCanvasRgba(a.px.data(), a.w, a.h, a.Stride(), 0, 0, kSeedA);
    bool alpha_intact = true;
    for (size_t i = 3; i < a.px.size(); i += 4) {
      alpha_intact = alpha_intact && (a.px[i] == canvas.px[i]);
    }
    Check(alpha_intact, "alpha is never modified");
  }

  // Seed 0 disables canvas farbling entirely.
  {
    Image canvas = Scene(32, 32, 27);
    Image a = canvas;
    lobium::FarbleCanvasRgba(a.px.data(), a.w, a.h, a.Stride(), 0, 0, 0);
    Check(std::memcmp(a.px.data(), canvas.px.data(), a.px.size()) == 0, "seed 0 is a no-op");
  }

  // ORACLE: coincident geometry must stay coincident. Honest Chrome returns exactly equal doubles
  // when a child fills its parent, when one element's bottom is the next one's top, and for two
  // identically laid-out elements. Index-keyed noise gave those independent nudges.
  std::printf("\nlobium::FarbleClientRect\n");
  {
    float ax = 10.0f, ay = 20.0f, aw = 100.0f, ah = 50.0f;
    float bx = 10.0f, by = 20.0f, bw = 100.0f, bh = 50.0f;
    lobium::FarbleClientRect(&ax, &ay, &aw, &ah, kSeedA);
    lobium::FarbleClientRect(&bx, &by, &bw, &bh, kSeedA);
    Check(ax == bx && ay == by && aw == bw && ah == bh,
          "two identical rects farble identically");

    // Sibling A's bottom == sibling B's top. Both are a `y` coordinate, so both go through the same
    // keyed transform and stay equal.
    float a_bottom = 70.0f, b_top = 70.0f;
    float ignore1 = 1.0f, ignore2 = 1.0f, ignore3 = 1.0f, ignore4 = 1.0f;
    float a_y = a_bottom, b_y = b_top;
    lobium::FarbleClientRect(&ignore1, &a_y, &ignore2, &ignore3, kSeedA);
    lobium::FarbleClientRect(&ignore4, &b_y, &ignore2, &ignore3, kSeedA);
    Check(a_y == b_y, "a shared edge coordinate stays shared");
  }
  {
    float x = 10.0f, y = 20.0f, w = 100.0f, h = 50.0f;
    lobium::FarbleClientRect(&x, &y, &w, &h, kSeedA);
    Check(std::fabs(x - 10.0f) <= 1.0f / 64.0f + 1e-6f, "the position delta is one LayoutUnit");
    Check(std::fabs(w - 100.0f) <= 1.0f / 64.0f + 1e-6f, "the size delta is one LayoutUnit");
    // offsetWidth is the rounded bounding-rect width in real Chrome; the nudge must not change it.
    Check(std::lround(w) == 100, "Math.round(width) still matches offsetWidth");
  }
  {
    float x = 5.0f, y = 5.0f, w = 5.0f, h = 5.0f;
    float x0 = x, y0 = y, w0 = w, h0 = h;
    lobium::FarbleClientRect(&x, &y, &w, &h, 0);
    Check(x == x0 && y == y0 && w == w0 && h == h0, "seed 0 is a no-op");
  }

  std::printf("\n%s (%d failure%s)\n", g_failures ? "FAILED" : "PASSED", g_failures,
              g_failures == 1 ? "" : "s");
  return g_failures ? 1 : 0;
}
