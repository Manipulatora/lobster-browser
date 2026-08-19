// Copyright 2026 The Lobster Browser Authors.
//
// See lobium_webgpu.h.

#include "components/lobium_fp/lobium_webgpu.h"

#include <limits>

namespace lobium {

namespace {

// A ceiling that never binds, for the classes where the honest backend value is already the right
// answer: a persona that declares itself a CPU adapter IS the software rasterizer it is running on.
constexpr WebGpuCeilings kUnbounded = {
    /*max_texture_dimension_1d=*/std::numeric_limits<uint32_t>::max(),
    /*max_texture_dimension_2d=*/std::numeric_limits<uint32_t>::max(),
    /*max_texture_dimension_3d=*/std::numeric_limits<uint32_t>::max(),
    /*max_texture_array_layers=*/std::numeric_limits<uint32_t>::max(),
    /*max_uniform_buffer_binding_size=*/std::numeric_limits<uint64_t>::max(),
    /*max_storage_buffer_binding_size=*/std::numeric_limits<uint64_t>::max(),
    /*max_buffer_size=*/std::numeric_limits<uint64_t>::max(),
    /*max_compute_workgroup_storage_size=*/std::numeric_limits<uint32_t>::max(),
    /*max_compute_invocations_per_workgroup=*/std::numeric_limits<uint32_t>::max(),
    /*max_compute_workgroup_size_x=*/std::numeric_limits<uint32_t>::max(),
    /*max_compute_workgroup_size_y=*/std::numeric_limits<uint32_t>::max(),
    /*max_compute_workgroup_size_z=*/std::numeric_limits<uint32_t>::max(),
    /*max_compute_workgroups_per_dimension=*/std::numeric_limits<uint32_t>::max(),
};

// What a desktop discrete part reports through D3D12 or Vulkan. maxBufferSize is the one figure that
// tracks board memory rather than the API tier, so it is the one that separates the two desktop
// classes; the rest are what every current desktop driver exposes.
constexpr WebGpuCeilings kDiscrete = {
    /*max_texture_dimension_1d=*/16384,
    /*max_texture_dimension_2d=*/16384,
    /*max_texture_dimension_3d=*/2048,
    /*max_texture_array_layers=*/2048,
    /*max_uniform_buffer_binding_size=*/65536,
    /*max_storage_buffer_binding_size=*/2147483644,
    /*max_buffer_size=*/4294967296,
    /*max_compute_workgroup_storage_size=*/32768,
    /*max_compute_invocations_per_workgroup=*/1024,
    /*max_compute_workgroup_size_x=*/1024,
    /*max_compute_workgroup_size_y=*/1024,
    /*max_compute_workgroup_size_z=*/64,
    /*max_compute_workgroups_per_dimension=*/65535,
};

// An integrated part shares system memory, so its buffer ceilings sit a tier below a board with its
// own VRAM while the API-tier limits match.
constexpr WebGpuCeilings kIntegrated = {
    /*max_texture_dimension_1d=*/16384,
    /*max_texture_dimension_2d=*/16384,
    /*max_texture_dimension_3d=*/2048,
    /*max_texture_array_layers=*/2048,
    /*max_uniform_buffer_binding_size=*/65536,
    /*max_storage_buffer_binding_size=*/2147483644,
    /*max_buffer_size=*/2147483648,
    /*max_compute_workgroup_storage_size=*/32768,
    /*max_compute_invocations_per_workgroup=*/1024,
    /*max_compute_workgroup_size_x=*/1024,
    /*max_compute_workgroup_size_y=*/1024,
    /*max_compute_workgroup_size_z=*/64,
    /*max_compute_workgroups_per_dimension=*/65535,
};

}  // namespace

WebGpuCeilings WebGpuCeilingsFor(std::string_view adapter_type) {
  if (adapter_type == "discrete") {
    return kDiscrete;
  }
  if (adapter_type == "integrated") {
    return kIntegrated;
  }
  return kUnbounded;
}

bool WebGpuFeatureAllowed(std::string_view feature,
                          std::string_view vendor,
                          std::string_view ua_platform) {
  const bool mobile_gpu = ua_platform == "Android";
  const bool apple_gpu = vendor == "apple";
  if (feature.starts_with("texture-compression-bc")) {
    return !mobile_gpu;
  }
  if (feature.starts_with("texture-compression-etc2") ||
      feature.starts_with("texture-compression-astc")) {
    return mobile_gpu || apple_gpu;
  }
  return true;
}

}  // namespace lobium
