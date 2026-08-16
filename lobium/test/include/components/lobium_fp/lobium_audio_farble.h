// Shim so the real kernel source can be compiled outside a Chromium checkout.
//
// lobium_audio_farble.cc includes its header by the in-tree path
// "components/lobium_fp/lobium_audio_farble.h". Putting this file on the include path lets the
// harness compile the SHIPPING .cc unmodified, so the properties are checked against real code
// rather than a re-implementation that could drift.
#include "../../../../src/lobium_audio_farble.h"
