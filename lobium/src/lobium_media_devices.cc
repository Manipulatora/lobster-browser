// Copyright 2026 The Lobster Browser Authors.
//
// See lobium_media_devices.h.

#include "components/lobium_fp/lobium_media_devices.h"

#include <array>

#include "base/containers/span.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "crypto/hash.h"
#include "crypto/hmac.h"

namespace lobium {

namespace {

// Distinct salt domains for deviceId and groupId. Real Chrome keeps two independent salts so a
// device's groupId cannot be derived from its deviceId; mirroring that with a domain-separation
// prefix over one salt gives the same observable independence.
constexpr std::string_view kDeviceDomain = "lobium-device-id";
constexpr std::string_view kGroupDomain = "lobium-group-id";

}  // namespace

std::string MediaDeviceHmacId(std::string_view origin,
                              std::string_view salt,
                              std::string_view kind,
                              int index,
                              bool group) {
  // Keyed on the ORIGIN, exactly as Chrome does, so the same device reports a different id to every
  // site and cannot be used to correlate a visitor across domains.
  const std::array<uint8_t, crypto::hash::kSha256Size> mac = crypto::hmac::SignSha256(
      base::as_byte_span(origin),
      base::as_byte_span(base::StrCat({group ? kGroupDomain : kDeviceDomain, "\x1f", salt, "\x1f",
                                       kind, "\x1f", base::NumberToString(index)})));
  return base::HexEncodeLower(mac);
}

std::string MediaDeviceSaltFromSeed(uint32_t seed) {
  // Widen the 32-bit seed into a salt-shaped string. Hashing rather than formatting the integer
  // means the salt does not literally contain the seed, so a leaked id gives no shortcut back to it
  // beyond brute-forcing the 32-bit space the seed genuinely has.
  const std::array<uint8_t, crypto::hash::kSha256Size> digest =
      crypto::hash::Sha256(base::as_byte_span(
          base::StrCat({"lobium-media-salt\x1f", base::NumberToString(seed)})));
  return base::HexEncodeLower(base::span(digest).first(16u));
}

}  // namespace lobium
