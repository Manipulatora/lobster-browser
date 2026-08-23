// Copyright 2026 The Lobster Browser Authors.
//
// See lobium_media_devices.h.

#include "components/lobium_fp/lobium_media_devices.h"

#include <array>

#include "base/containers/span.h"
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
  // CAMERA LABELS CARRY " (vid:pid)". A video device's label is built by
  // WebMediaDeviceInfo(label(descriptor.GetNameAndModel())), and GetNameAndModel() appends
  // " (" + model_id + ")" whenever the model id is non-empty - which it is on all three desktop
  // platforms (media/capture/video/video_capture_device_descriptor.cc). A camera label with no
  // suffix is a shape desktop Chrome does not produce. Android is the exception and stays bare.
  //
  // USB AUDIO endpoints carry it too, from GetDeviceSuffixWin()
  // (media/audio/win/device_enumeration_win.cc), whose unit test pins the exact " (0403:6010)"
  // form. Onboard HDAUDIO endpoints correctly get NO suffix, which is why the Realtek entries
  // below are unchanged.
  if (platform == "Windows") {
    if (kind == "videoinput") {
      return integrated ? "Integrated Camera (04f2:b6d9)" : "USB Video Device (046d:0825)";
    }
    if (kind == "audioinput") {
      return integrated ? "Microphone (Realtek(R) Audio)"
                        : "Microphone (USB Audio Device) (0d8c:0014)";
    }
    return integrated ? "Speakers (Realtek(R) Audio)"
                      : "Speakers (USB Audio Device) (0d8c:0014)";
  }
  if (platform == "macOS") {
    if (kind == "videoinput") {
      return integrated ? "FaceTime HD Camera (05ac:8514)" : "USB Camera (046d:0825)";
    }
    if (kind == "audioinput") {
      return integrated ? "MacBook Pro Microphone" : "External Microphone";
    }
    return integrated ? "MacBook Pro Speakers" : "External Headphones";
  }
  if (platform == "Android") {
    // "camera N, facing X" - VideoCaptureCamera2.java builds it as
    // "camera " + index + ", facing " + displayFacing. There is no "camera2" in the label; that is
    // the name of the Android API, not of the device, and emitting it was a string no Chrome sends.
    if (kind == "videoinput") {
      return integrated ? "camera 0, facing back" : "camera 1, facing front";
    }
    return "";
  }
  // Linux, where V4L2 supplies the camera name and PulseAudio the card profile name.
  if (kind == "videoinput") {
    return integrated ? "Integrated Camera: Integrated C (04f2:b6d9)"
                      : "USB Camera: USB Camera (046d:0825)";
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

std::string CreateMediaDeviceDocumentSalt() {
  return base::UnguessableToken::Create().ToString();
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
