# Lobster Kernel patch series

Quilt-style patch series (the ungoogled-chromium model) applied on top of the pinned Chromium ref.
`series` lists patch files in apply order. Group by domain, e.g.:

```
core/navigator-ua-ch.patch
core/config-channel.patch
fingerprint/canvas-farbling.patch
fingerprint/webgl-vendor-renderer.patch
fingerprint/audio-context.patch
net/tls-ja4.patch
net/http2-settings-order.patch
```

Each patch is small, focused, reviewed by Claude, and carries a header comment explaining the surface
it controls and how it reads the per-profile config (see `../config-channel.md`). First patch
(navigator/UA-CH) + the config channel land in **T-011**.
