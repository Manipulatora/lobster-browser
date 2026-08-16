// Property tests for lobium::FarbleAudioSamples.
//
// These are not unit tests of an implementation detail. Each one is a DETECTION ORACLE that a page
// can run in a few lines, taken from docs/ENGINE_AUDIT.md. If one of them fails, the engine is
// distinguishable from honest Chrome — that is the whole point of the kernel.
//
// Run with lobium/test/run.ps1. No Chromium checkout required.

#include "components/lobium_fp/lobium_audio_farble.h"

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

double UlpsBetween(float a, float b) {
  uint32_t ua, ub;
  std::memcpy(&ua, &a, sizeof(ua));
  std::memcpy(&ub, &b, sizeof(ub));
  return std::fabs(static_cast<double>(ua) - static_cast<double>(ub));
}

std::vector<float> Noise(size_t n, uint32_t rng_seed, float amp = 1.0f) {
  std::mt19937 rng(rng_seed);
  std::uniform_real_distribution<float> d(-amp, amp);
  std::vector<float> v(n);
  for (auto& x : v) {
    x = d(rng);
  }
  return v;
}

constexpr uint32_t kSeedA = 0x1234abcdu;
constexpr uint32_t kSeedB = 0x9f00beefu;

}  // namespace

int main() {
  std::printf("lobium::FarbleAudioSamples\n");

  // ORACLE: `new ConstantSourceNode(ctx, {offset: 0.5})` rendered through an OfflineAudioContext.
  // Honest Chrome fills the bus with std::ranges::fill and copies bytes — no arithmetic — so every
  // frame is exactly 0x3F000000 on every platform ever shipped. `d.some(v => v !== 0.5)` is false
  // there and must be false here. Index-keyed noise turned one constant into 8192 distinct values.
  {
    std::vector<float> v(8192, 0.5f);
    lobium::FarbleAudioSamples(v.data(), v.size(), kSeedA);
    bool flat = true;
    for (float x : v) {
      flat = flat && (x == v[0]);
    }
    Check(flat, "a constant input renders exactly constant");
    std::printf("      0.5 -> %.9g (%.0f ULP)\n", static_cast<double>(v[0]),
                UlpsBetween(0.5f, v[0]));
  }

  // ORACLE: silence must read back as silence. A denormal where a zero belongs is nonsense no
  // honest render produces.
  {
    std::vector<float> v(1024, 0.0f);
    lobium::FarbleAudioSamples(v.data(), v.size(), kSeedA);
    bool zero = true;
    for (float x : v) {
      zero = zero && (x == 0.0f);
    }
    Check(zero, "exact zero stays exact zero");
  }

  // ORACLE: idempotence. A sample that passes through two farbled taps — an offline AudioWorklet or
  // ScriptProcessorNode feeding the farbled destination buffer — must be perturbed once, not twice.
  // The old kernel produced (1+eps)^2 on that route against (1+eps) on a direct one, which is a
  // contradiction honest Chrome cannot produce. Idempotence also removes every cross-route keying
  // mismatch, because no route-dependent index is involved any more.
  {
    std::vector<float> base = Noise(200000, 7);
    std::vector<float> once = base;
    std::vector<float> twice = base;
    lobium::FarbleAudioSamples(once.data(), once.size(), kSeedA);
    lobium::FarbleAudioSamples(twice.data(), twice.size(), kSeedA);
    lobium::FarbleAudioSamples(twice.data(), twice.size(), kSeedA);
    Check(std::memcmp(once.data(), twice.data(), once.size() * sizeof(float)) == 0,
          "idempotent: applying it twice equals applying it once");
  }

  // ORACLE: `channelData(0)[k] === channelData(1)[k]` after an honest mono-to-stereo upmix. Value
  // keying gives this for free; a per-channel key would break it.
  {
    std::vector<float> ch0 = Noise(4096, 11);
    std::vector<float> ch1 = ch0;
    lobium::FarbleAudioSamples(ch0.data(), ch0.size(), kSeedA);
    lobium::FarbleAudioSamples(ch1.data(), ch1.size(), kSeedA);
    Check(std::memcmp(ch0.data(), ch1.data(), ch0.size() * sizeof(float)) == 0,
          "an upmixed mono signal stays bit-identical across channels");
  }

  // Amplitude. Whole float32 ULPs only, so every emitted value is one honest float arithmetic could
  // have produced. The previous kernel used a 1.5e-3 relative multiply — about 12,600 ULP, which
  // randomised the bottom ~13.6 of the 24 significand bits.
  {
    std::vector<float> a = Noise(200000, 13);
    std::vector<float> b = a;
    lobium::FarbleAudioSamples(b.data(), b.size(), kSeedA);
    double max_ulp = 0;
    double max_rel = 0;
    size_t moved = 0;
    for (size_t i = 0; i < a.size(); ++i) {
      if (a[i] != b[i]) {
        moved++;
      }
      max_ulp = std::fmax(max_ulp, UlpsBetween(a[i], b[i]));
      if (a[i] != 0.0f) {
        max_rel = std::fmax(max_rel, std::fabs(static_cast<double>(b[i]) - a[i]) /
                                         std::fabs(static_cast<double>(a[i])));
      }
    }
    Check(max_ulp <= 2.0, "never moves a sample by more than two ULP");
    Check(max_rel < 2.4e-7, "relative deviation stays below 2.4e-7");
    Check(moved > a.size() / 10, "still perturbs enough samples to change any hash");
    std::printf("      moved %zu/%zu (%.1f%%), max %.0f ULP, max rel %.3g\n", moved, a.size(),
                100.0 * static_cast<double>(moved) / static_cast<double>(a.size()), max_ulp,
                max_rel);
  }

  // Per-profile behaviour: stable for one seed, different across seeds, different from the host.
  {
    std::vector<float> base = Noise(65536, 17);
    std::vector<float> a = base, a2 = base, b = base;
    lobium::FarbleAudioSamples(a.data(), a.size(), kSeedA);
    lobium::FarbleAudioSamples(a2.data(), a2.size(), kSeedA);
    lobium::FarbleAudioSamples(b.data(), b.size(), kSeedB);
    const size_t bytes = base.size() * sizeof(float);
    Check(std::memcmp(a.data(), a2.data(), bytes) == 0, "stable for a given seed");
    Check(std::memcmp(a.data(), b.data(), bytes) != 0, "distinct across seeds");
    Check(std::memcmp(a.data(), base.data(), bytes) != 0, "differs from the host");
  }

  // ORACLE: the manifold check that CreepJS and commercial stacks actually run — render the
  // canonical FingerprintJS graph, sum |x| over 500 samples, and measure the distance to the known
  // Chrome value cluster. The honest x86 desktop spread of that sum is about 2e-7 relative. The
  // previous kernel shifted it by ~3.9e-5, roughly 190x the entire honest spread, putting every
  // profile off the manifold — detectable without knowing anything about the host.
  {
    std::vector<float> a = Noise(500, 19, 0.5f);
    double sum_true = 0;
    for (float x : a) {
      sum_true += std::fabs(static_cast<double>(x));
    }
    double worst = 0;
    for (uint32_t s = 1; s <= 64; ++s) {
      std::vector<float> b = a;
      lobium::FarbleAudioSamples(b.data(), b.size(), s * 2654435761u);
      double sum = 0;
      for (float x : b) {
        sum += std::fabs(static_cast<double>(x));
      }
      worst = std::fmax(worst, std::fabs(sum - sum_true) / sum_true);
    }
    Check(worst < 2e-7, "the 500-sample sum stays inside the honest 2e-7 population spread");
    std::printf("      worst relative sum shift over 64 seeds: %.3g\n", worst);
  }

  // A zero seed must be a complete no-op: that is how a profile disables audio farbling.
  {
    std::vector<float> a = Noise(4096, 23);
    std::vector<float> b = a;
    lobium::FarbleAudioSamples(b.data(), b.size(), 0);
    Check(std::memcmp(a.data(), b.data(), a.size() * sizeof(float)) == 0, "seed 0 is a no-op");
  }

  std::printf("\n%s (%d failure%s)\n", g_failures ? "FAILED" : "PASSED", g_failures,
              g_failures == 1 ? "" : "s");
  return g_failures ? 1 : 0;
}
