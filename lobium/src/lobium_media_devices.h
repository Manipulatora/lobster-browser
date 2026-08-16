// Copyright 2026 The Lobster Browser Authors.
//
// Persona media-device identifiers, shaped exactly like the ones Chrome emits.

#ifndef COMPONENTS_LOBIUM_FP_LOBIUM_MEDIA_DEVICES_H_
#define COMPONENTS_LOBIUM_FP_LOBIUM_MEDIA_DEVICES_H_

#include <cstdint>
#include <string>
#include <string_view>

namespace lobium {

// Build the deviceId (or groupId) a persona should report for one enumerated device.
//
// WHAT REAL CHROME DOES, and therefore what this has to reproduce
// (content/browser/media/media_devices_util.cc, GetHMACForRawMediaDeviceID):
//
//   * The id is HMAC-SHA256 over the raw device id plus a per-profile salt, KEYED ON THE REQUESTING
//     ORIGIN, hex-encoded lowercase. That is 64 hex characters, not 32.
//   * Because the origin is the HMAC key, the SAME physical device reports a DIFFERENT id to every
//     site. A spoof that returns one id everywhere is a cross-origin correlation a real browser
//     never permits, and is trivially detected by comparing ids across two of your own domains.
//   * `groupId` uses a SEPARATE salt from `deviceId`, so the two are unrelated for the same device.
//
// The previous implementation got all three wrong: 32 hex chars, origin-independent, and built by
// XORing one 32-bit value with a per-word constant - which meant ~16 bits of real entropy and made
// any two words of the id recover the seed. This function replaces it with the real construction.
//
// `origin` is the serialized requesting origin (e.g. "https://example.com"), `salt` the per-profile
// secret, `kind` a stable label such as "audioinput", `index` the device's position within its kind,
// and `group` selects the group-id salt domain so a device's groupId and deviceId never coincide.
// Returns 64 lowercase hex characters.
std::string MediaDeviceHmacId(std::string_view origin,
                              std::string_view salt,
                              std::string_view kind,
                              int index,
                              bool group);

// Derive a stable per-profile salt from the 32-bit media-devices seed.
//
// Chrome's real salt is a 128-bit random token persisted per profile. The config channel currently
// carries a 32-bit seed, so this widens it deterministically. It is NOT a claim of 128 bits of
// entropy - it is a shaping step so the HMAC input has the right form. Populating a real 128-bit
// `deviceSalt` in the config supersedes this; pass that through directly when present.
std::string MediaDeviceSaltFromSeed(uint32_t seed);

}  // namespace lobium

#endif  // COMPONENTS_LOBIUM_FP_LOBIUM_MEDIA_DEVICES_H_
