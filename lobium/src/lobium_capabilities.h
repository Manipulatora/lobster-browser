// Copyright 2026 The Lobster Browser Authors.
//
// The native fingerprint capability contract: a machine-readable statement of which hooks are
// compiled into THIS executable.
//
// WHY IT IS SINGLE-SOURCED HERE. The sidecar refuses to launch a profile unless the binary proves it
// contains the hooks the profile's policy needs, so this list is a load-bearing safety claim rather
// than documentation. It previously lived as a string literal inside the chrome_main.cc patch, which
// meant adding a hook and forgetting the literal produced a binary that silently under-reported, and
// editing the literal without adding the hook produced one that LIED - the worse direction, because
// the sidecar would then launch a profile whose spoofing does not exist. Keeping the list in the
// added module means one edit site, and ci/validation/patch-series.test.mjs cross-checks it against
// both the patch series and the TypeScript mirror so the three cannot drift apart unnoticed.
//
// Platform-conditional entries use BUILDFLAG rather than being listed unconditionally: a Linux build
// genuinely does not contain the DirectWrite font hooks, and claiming otherwise would be the same
// lie in a different place.

#ifndef COMPONENTS_LOBIUM_FP_LOBIUM_CAPABILITIES_H_
#define COMPONENTS_LOBIUM_FP_LOBIUM_CAPABILITIES_H_

#include <string>

namespace lobium {

// Contract version. This covers both the JSON shape and the behavioural guarantees represented by
// each capability name. Bump whenever an older binary could truthfully print the same names while
// implementing weaker semantics; otherwise a stale runtime can pass the launch gate. A bump requires
// the matching change to LOBIUM_CAPABILITY_CONTRACT_VERSION in the sidecar, which rejects every
// other version.
inline constexpr int kCapabilityContractVersion = 2;

// The JSON document printed for --lobium-fingerprint-capabilities, on one line, stdout only.
std::string CapabilityManifestJson();

}  // namespace lobium

#endif  // COMPONENTS_LOBIUM_FP_LOBIUM_CAPABILITIES_H_
