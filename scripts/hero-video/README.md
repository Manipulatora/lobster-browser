# Lobster hero video production

This folder contains the deterministic compositor for the 20-second Lobster Browser hero video.
It combines the exact, unmodified first-party Lobster mark with reference-driven lifestyle footage,
an organic virtual lobster, and the requested platform marks. It contains no website or dashboard UI.

No API key is stored here. The clean start-frame references are committed under `references-v2/`;
generated source plates remain outside the repository under `/tmp/lobster-hero-v2/plates`.

The accepted source plates are generated with `venice-i2v.mjs` and the matching `*-motion.txt`
prompts. The API key is entered through a muted terminal prompt and is never written to disk.

Platform vector shapes under `icons-v2/` are pinned from Simple Icons 9.21.0. LinkedIn, Facebook,
Instagram, Twitter, Upwork, and Freelancer remain trademarks of their respective owners.

## Render

Render selected review frames:

```bash
node scripts/hero-video/render-final.mjs 0 60 150 270 390 435 480 540 570 599
```

Render all 600 frames:

```bash
node scripts/hero-video/render-final.mjs
```

The default output is `/tmp/lobster-hero-v2/rendered-frames`. Frame ranges such as `120:139` are
supported so native-4K sources can be rendered in bounded decoder sessions.

## Encode

The web asset is a silent 1300×1300, 30 fps VP9 WebM. The outer area beyond the rounded film
aperture is an exact-white matte so it disappears against the site canvas:

```bash
gst-launch-1.0 -e \
  multifilesrc location=/tmp/lobster-hero-v2/rendered-frames/frame-%04d.png \
  caps="image/png,framerate=30/1" \
  ! pngdec ! videoconvert \
  ! "video/x-raw,format=I420,colorimetry=bt601" \
  ! vp9enc deadline=1 cpu-used=5 target-bitrate=4000000 threads=4 keyframe-max-dist=120 \
  ! webmmux \
  ! filesink location=apps/web/public/video/lobster-hero-v3.webm
```
