// Copyright 2026 The Lobster Browser Authors.
//
// See lobium_media_devices.h.

#include "components/lobium_fp/lobium_media_devices.h"

#include <array>

#include "base/containers/span.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/unguessable_token.h"
#include "crypto/hash.h"
#include "crypto/hmac.h"

namespace lobium {

namespace {

// Distinct salt domains for deviceId and groupId. Real Chrome keeps two independent salts so a
// device's groupId cannot be derived from its deviceId; mirroring that with a domain-separation
// prefix over one salt gives the same observable independence.
constexpr std::string_view kDeviceDomain = "lobium-device-id";
constexpr std::string_view kGroupDomain = "lobium-group-id";

// The name each platform's capture stack reports for the hardware at `index` within `kind`. Index 0
// is the integrated device every persona machine is built around; beyond it the plug-in shape is
// used, because a second camera or sound card on a desktop is a USB one.
//
// An empty return means the platform has no name of its own for that slot, which is how Android
// behaves: its AudioManager enumerates the virtual default device and nothing else, so the label
// collapses to the bare "Default" that GetDefaultDeviceName() produces from an empty real name.
std::string_view HardwareName(std::string_view platform,
                              std::string_view kind,
                              int index) {
  const bool integrated = index <= 0;
  if (platform == "Windows") {
    if (kind == "videoinput") {
      return integrated ? "Integrated Camera" : "USB Video Device";
    }
    if (kind == "audioinput") {
      return integrated ? "Microphone (Realtek(R) Audio)"
                        : "Microphone (USB Audio Device)";
    }
    return integrated ? "Speakers (Realtek(R) Audio)"
                      : "Speakers (USB Audio Device)";
  }
  if (platform == "macOS") {
    if (kind == "videoinput") {
      return integrated ? "FaceTime HD Camera" : "USB Camera";
    }
    if (kind == "audioinput") {
      return integrated ? "MacBook Pro Microphone" : "External Microphone";
    }
    return integrated ? "MacBook Pro Speakers" : "External Headphones";
  }
  if (platform == "Android") {
    // Android names a camera by its camera2 id and the lens it faces; id 1 is the front lens.
    if (kind == "videoinput") {
      return integrated ? "camera2 0, facing back" : "camera2 1, facing front";
    }
    return "";
  }
  // Linux, where V4L2 supplies the camera name and PulseAudio the card profile name.
  if (kind == "videoinput") {
    return integrated ? "Integrated Camera: Integrated C" : "USB Camera: USB Camera";
  }
  return integrated ? "Built-in Audio Analog Stereo" : "USB Audio Analog Stereo";
}

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

std::string MediaDeviceEphemeralSalt() {
  static const base::NoDestructor<std::string> salt(
      base::UnguessableToken::Create().ToString());
  return *salt;
}

std::string MediaDeviceLabel(std::string_view ua_platform,
                             std::string_view kind,
                             int index,
                             std::string_view pseudo) {
  // A pseudo-device carries the name of the REAL device it points at, prefixed - which is why the
  // hardware name is looked up at index 0 for it rather than at the caller's index.
  const std::string_view name =
      HardwareName(ua_platform, kind, pseudo.empty() ? index : 0);
  if (pseudo == "default") {
    return name.empty() ? std::string("Default")
                        : base::StrCat({"Default - ", name});
  }
  if (pseudo == "communications") {
    return name.empty() ? std::string("Communications")
                        : base::StrCat({"Communications - ", name});
  }
  return std::string(name);
}

}  // namespace lobium
