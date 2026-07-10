# Real-GPU stealth gate (QA-1)

> **Why this exists.** Every "zero lies" result to date was produced on a **software renderer**
> (SwiftShader) — see `ci/validation/reports/creepjs-battle-latest.json` (`gpuMode: "software"`). On a
> software host, CreepJS cannot contradict a persona that *claims* a discrete GPU, so `120/120` is a
> **false pass**. This gate makes real-hardware, zero-lies proof a blocking, falsifiable CI signal, and
> makes the SwiftShader false-pass impossible to merge. It is the concrete answer to PROJECT-STATUS
> gaps #1 (real-GPU proof) and #3 (native CI gate).

## What the gate enforces

The workflow [`.github/workflows/real-gpu-gate.yml`](../../.github/workflows/real-gpu-gate.yml) runs
three steps on a self-hosted GPU runner and then applies the strict referee
[`ci/validation/gate.mjs`](../../ci/validation/gate.mjs):

1. `lobium-detect.mjs` — single-persona native detector (surfaces applied + Sannysoft + CreepJS).
2. `creepjs-battle.mjs` — the 100+ situation CreepJS matrix.
3. `gate.mjs` — **fails the job** unless *all* of the following hold:

| Invariant | Why |
|---|---|
| `gpuMode === "gpu"` (battle + detect) | A software run is not evidence. |
| `host.renderer` present and **not** SwiftShader/llvmpipe/Mesa-OffScreen/etc. | The false-pass trap. `isSoftwareRenderer` from `@lobster/engine-runner` is the single source of truth; a *missing* renderer also fails (can't confirm hardware). |
| `situations >= LOBSTER_GATE_MIN_SITUATIONS` (default 100) | A 1-situation run can't sneak through. |
| `fail === 0 && error === 0 && unavailable === 0` | No situation errored or was skipped. |
| `pass === situations` and `zeroLies === situations` and `meanLies === 0` | **Every** scored persona had zero CreepJS lies. |
| `lobium-detect` `verdict === "pass"` and `softwareRenderer === false` | Single-persona surfaces coherent on real hardware. |

Run it locally against the newest reports:

```bash
npx tsc -b packages/shared-types packages/proxy packages/fingerprint packages/engine-runner
node ci/validation/gate.mjs           # evaluates ci/validation/reports/creepjs-battle-latest.json (+ newest lobium-detect)
```

Against the current SwiftShader report it prints `GATE FAIL: 2/9 checks failed` — proving it catches
exactly the thing that was previously being reported as success.

## Standing up the self-hosted GPU runner

You need **one** Linux box with a consumer GPU (NVIDIA GTX/RTX or AMD; a data-center card like the
RTX 5090 already used is fine for a first datapoint but is not representative of the median target
device — add a mid-range consumer GPU baseline before any "Octo-class" claim).

### 1. Host prerequisites

```bash
# NVIDIA example (Ubuntu 24.04):
sudo apt-get update
sudo apt-get install -y \
  build-essential curl file xvfb \
  libvulkan1 mesa-vulkan-drivers vulkan-tools \
  libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64   # Chromium runtime libs
# Install the vendor GPU + Vulkan driver (nvidia-driver-xxx / mesa for AMD). Then verify:
vulkaninfo | head -20        # must list your real GPU, NOT "llvmpipe" / "SwiftShader"
glxinfo -B | grep -i device  # sanity check the GL renderer
```

A **real display** matters: run the runner under a logged-in X session, or a persistent Xvfb/Xorg
with the GPU attached. WebGL on the physical driver needs a GPU-backed display; a bare headless box
falls back to SwiftShader — which the gate now rejects.

Node: install the version in [`.nvmrc`](../../.nvmrc) (via `nvm` or `fnm`).

### 2. Build the Lobium binary on this box

Follow [`lobium/REPRODUCIBLE_BUILD.md`](../../lobium/REPRODUCIBLE_BUILD.md) / `lobium/build.sh` to
produce `.../out/Lobium/chrome`. **This is the fix for provenance gap #3**: the binary must be
buildable on the runner, not copied from a laptop. Record the Chromium ref and build args in the run.

### 3. Register the GitHub Actions runner

```bash
# Repo → Settings → Actions → Runners → New self-hosted runner. Then on the box:
mkdir actions-runner && cd actions-runner
# (download + configure per the page's token)
./config.sh --url https://github.com/<org>/<repo> --token <TOKEN> --labels gpu --name lobium-gpu-1
sudo ./svc.sh install && sudo ./svc.sh start    # run as a service so nightly cron fires
```

The workflow targets `runs-on: [self-hosted, gpu]`, so the `gpu` label is required.

### 4. Repo variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Example | Notes |
|---|---|---|
| `LOBSTER_LOBIUM_BIN` | `/home/runner/lobium-build/src/out/Lobium/chrome` | Absolute path to the built binary on the runner. |
| `DISPLAY` | `:0` | The GPU-backed X display the runner can reach. |
| `LOBSTER_ANGLE_BACKEND` | `vulkan` | Or `gl`. Match what your driver renders hardware on. |
| `VK_ICD_FILENAMES` | `/usr/share/vulkan/icd.d/nvidia_icd.json` | Point ANGLE/Vulkan at the real ICD, not the software one. |

### 5. Prove it, then promote to a merge gate

- Trigger manually: Actions → **Real-GPU stealth gate** → Run workflow.
- Confirm the run ends with `GATE PASS: 9/9 checks passed — real-GPU zero-lies proof.` and download
  the `real-gpu-reports-*` artifact. The battle report should now show a real `host.renderer` and
  `gpuMode: "gpu"`.
- Once the runner is reliably online, uncomment the `pull_request:` trigger in the workflow to make
  the gate block merges to `main`.

## Expected first result (be honest with yourself)

The first real-GPU run will very likely **not** be `9/9`. PROJECT-STATUS already names the confirmed
open tell: **HC-4 deep-WebGL** (`getSupportedExtensions()` / `getShaderPrecisionFormat()` / `gl.VERSION`
leak the host GPU because the Blink hook that consumes the parsed config is not compiled into the
binary yet). That is exactly what this gate is meant to surface. Closing HC-4
([`lobium/patches/fingerprint/host-gpu-profile.patch`](../../lobium/patches/fingerprint/host-gpu-profile.patch))
and rebuilding is the first thing the gate will validate.
