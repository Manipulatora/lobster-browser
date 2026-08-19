// Copyright 2026 The Lobster Browser Authors.
//
// Persona-shaped WebGPU adapter capabilities, coherent with the identity adapter.info reports.

#ifndef COMPONENTS_LOBIUM_FP_LOBIUM_WEBGPU_H_
#define COMPONENTS_LOBIUM_FP_LOBIUM_WEBGPU_H_

#include <cstdint>
#include <string_view>

namespace lobium {

// The ceilings a persona of `adapter_type` ("discrete" | "integrated" | "cpu") should report through
// GPUAdapter.limits.
//
// adapter.limits, adapter.features and adapter.info describe the SAME device, and a page reads all
// three from one object. Overriding only the identity moves the contradiction rather than closing
// it: a spoofed discrete GeForce whose limits and feature set are the host's - a software rasterizer
// on the GPU-less hosts these profiles usually run on, or a completely different card on a desktop
// host - is still one object disagreeing with itself.
//
// EVERY VALUE HERE IS A CEILING AND NEVER A FLOOR. GPUAdapter.limits is what requestDevice()
// validates requiredLimits against and GPUDevice.limits then reports back, so raising a limit
// advertises capability the backend cannot deliver: the device request fails, or succeeds with
// device.limits below adapter.limits, and a passive tell becomes an active one. That is the rule
// fingerprint/webgl-runtime-safety.patch applies to the WebGL caps, with the same residual - a
// backend WEAKER than the persona class cannot be lifted to match it, only reported honestly.
//
// Only limits that genuinely separate hardware classes are listed. The "min*" limits are omitted on
// purpose: for those a LOWER number is the more capable device, so clamping them down would raise
// the advertised capability.
struct WebGpuCeilings {
  uint32_t max_texture_dimension_1d;
  uint32_t max_texture_dimension_2d;
  uint32_t max_texture_dimension_3d;
  uint32_t max_texture_array_layers;
  uint64_t max_uniform_buffer_binding_size;
  uint64_t max_storage_buffer_binding_size;
  uint64_t max_buffer_size;
  uint32_t max_compute_workgroup_storage_size;
  uint32_t max_compute_invocations_per_workgroup;
  uint32_t max_compute_workgroup_size_x;
  uint32_t max_compute_workgroup_size_y;
  uint32_t max_compute_workgroup_size_z;
  uint32_t max_compute_workgroups_per_dimension;
};

WebGpuCeilings WebGpuCeilingsFor(std::string_view adapter_type);

// Whether a persona on `ua_platform` with WebGPU vendor token `vendor` may advertise `feature`
// (a GPUFeatureName as the IDL spells it, e.g. "texture-compression-bc").
//
// The texture-compression families are the ones that name the hardware outright: block compression
// is the desktop family and no Android GPU exposes it, while ETC2/ASTC are the mobile family that
// desktop discrete and integrated parts do not have. Apple silicon is the one part with both, which
// is why the vendor token is consulted rather than the platform alone.
//
// Filtering only ever REMOVES a feature, for the reason the ceilings only ever lower a limit: a
// feature the backend does not have cannot be requested successfully, so adding one would be caught
// by the first requestDevice() that asked for it.
bool WebGpuFeatureAllowed(std::string_view feature,
                          std::string_view vendor,
                          std::string_view ua_platform);

}  // namespace lobium

#endif  // COMPONENTS_LOBIUM_FP_LOBIUM_WEBGPU_H_
