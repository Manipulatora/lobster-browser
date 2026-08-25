import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('quilt series wires every capability-gated native patch', async () => {
  const series = await read('lobium/patches/series');
  for (const patch of [
    'core/capability-contract.patch',
    'fingerprint/navigator-webdriver.patch',
    'fingerprint/locale-geolocation.patch',
    'fingerprint/host-gpu-profile.patch',
    'fingerprint/client-rects.patch',
    'fingerprint/media-devices.patch',
    'fingerprint/webrtc-policy.patch',
  ]) {
    assert.match(series, new RegExp(`^${patch.replaceAll('.', '\\.')}$`, 'm'));
  }
});

test('exact-build manifest and TypeScript contract stay synchronized', async () => {
  const [nativePatch, nativeSource, nativeHeader, contract, windowsPackager, runtimeVerifier] =
    await Promise.all([
      read('lobium/patches/core/capability-contract.patch'),
      read('lobium/src/lobium_capabilities.cc'),
      read('lobium/src/lobium_capabilities.h'),
      read('packages/engine-runner/src/lobium-capabilities.ts'),
      read('scripts/package-lobium-runtime.ps1'),
      read('scripts/verify-lobium-runtime.mjs'),
    ]);
  assert.match(nativePatch, /HasSwitch\("lobium-fingerprint-capabilities"\)/);
  assert.match(nativePatch, /lobium::CapabilityManifestJson\(\)/);

  const portable = [...nativeSource.matchAll(/^\s*"([a-z0-9-]+)",\s*$/gm)].map((m) => m[1]);
  const platformSpecific = [...nativeSource.matchAll(/names\.push_back\("([a-z0-9-]+)"\);/g)].map(
    (m) => m[1],
  );
  const nativeCapabilities = [...portable, ...platformSpecific];
  const tsBlock = /LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES = \[([\s\S]*?)\] as const;/.exec(
    contract,
  );
  assert.ok(tsBlock, 'could not parse the TypeScript capability list');
  const tsCapabilities = [...tsBlock[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(tsCapabilities, nativeCapabilities);
  assert.ok(nativeCapabilities.includes('navigator-webdriver'));

  const nativeVersion = /kCapabilityContractVersion = (\d+)/.exec(nativeHeader)?.[1];
  const tsVersion = /LOBIUM_CAPABILITY_CONTRACT_VERSION = (\d+)/.exec(contract)?.[1];
  const packagerVersion = /\$expectedContractVersion = (\d+)/.exec(windowsPackager)?.[1];
  const verifierVersion = /LOBIUM_CAPABILITY_CONTRACT_VERSION = (\d+)/.exec(runtimeVerifier)?.[1];
  assert.ok(
    nativeVersion && tsVersion && packagerVersion && verifierVersion,
    'could not parse every capability contract version',
  );
  assert.equal(tsVersion, nativeVersion);
  assert.equal(packagerVersion, nativeVersion);
  assert.equal(verifierVersion, nativeVersion);
  assert.ok(
    Number(nativeVersion) >= 3,
    'v2 cannot distinguish an engine that leaks local endpoints through icecandidateerror',
  );
});

test('locale/geolocation and WebRTC patches enforce the intended native semantics', async () => {
  const [locale, webrtc] = await Promise.all([
    read('lobium/patches/fingerprint/locale-geolocation.patch'),
    read('lobium/patches/fingerprint/webrtc-policy.patch'),
  ]);
  assert.match(locale, /NavigatorLanguage::EnsureUpdatedLanguage/);
  assert.match(locale, /RenderThreadImpl::Init/);
  assert.match(locale, /SetICUDefaultLocale\(cfg->locale\.locale\)/);
  assert.match(locale, /cfg->navigator\.languages/);
  assert.match(locale, /cfg->locale\.has_geolocation/);
  assert.match(locale, /normal browser permission service has granted access/);
  assert.match(webrtc, /cfg->net\.webrtc_policy == "disabled"/);
  assert.match(webrtc, /configuration\.type = webrtc::PeerConnectionInterface::kRelay/);
  assert.match(webrtc, /platform_candidate->Type\(\) != "relay"/);
  const webrtcAdded = webrtc
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
  const errorHookStart = webrtcAdded.indexOf(
    '// ICE candidate failures are a separate script-visible channel',
  );
  assert.notEqual(errorHookStart, -1, 'WebRTC patch does not cover icecandidateerror');
  const errorHook = webrtcAdded.slice(errorHookStart);
  assert.match(
    errorHook,
    /webrtc_policy == "disabled"\) \{\s*return;/,
    'disabled must suppress candidate-error events as well as successful candidates',
  );
  assert.match(
    errorHook,
    /webrtc_policy == "proxy_only" \|\|\s*cfg->net\.webrtc_policy == "disable_non_proxied_udp"/,
    'both proxied WebRTC modes must take the endpoint-redaction path',
  );
  assert.match(
    errorHook,
    /RTCPeerConnectionIceErrorEvent::Create\(\s*String\(\), std::nullopt, String\(\), url, error_code, error_text\)/,
    'protected modes must preserve relay failure details without exposing the local endpoint',
  );

  const farble = await read('lobium/src/lobium_farble.cc');
  assert.match(farble, /constexpr float kUnit = 1\.0f \/ 64\.0f/);
  assert.match(farble, /const float nx = nudge\(\*x, 0x11u\)/);
  assert.match(farble, /const float ny = nudge\(\*y, 0x22u\)/);
  assert.match(farble, /\*x = nx/);
  assert.match(farble, /\*y = ny/);
  assert.match(farble, /\*width = std::max\(kUnit, nudge\(\*width, 0x33u\)\)/);
});

test('media-device identity and capabilities match one coherent document-scoped persona', async () => {
  const [patch, helper] = await Promise.all([
    read('lobium/patches/fingerprint/media-devices.patch'),
    read('lobium/src/lobium_media_devices.cc'),
  ]);
  const addedSource = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');

  // The token is minted once by the MediaDevices constructor and retained as an instance member.
  // It must not be a process static (cross-document leak) or a local in DevicesEnumerated
  // (same-document churn on every call).
  assert.match(
    addedSource,
    /lobium_media_device_document_salt_\(lobium::CreateMediaDeviceDocumentSalt\(\)\)/,
  );
  assert.match(addedSource, /const std::string lobium_media_device_document_salt_;/);
  assert.match(
    helper,
    /std::string CreateMediaDeviceDocumentSalt\(\) \{\s*return base::UnguessableToken::Create\(\)\.ToString\(\);\s*\}/,
  );
  assert.doesNotMatch(helper, /MediaDeviceEphemeralSalt|NoDestructor/);

  // This is Chromium's GotSalt lifetime split: a stable id sees only the persisted profile salt;
  // an unstable id adds the document token; groupId adds the token in every policy mode.
  assert.match(
    addedSource,
    /md\.stable_device_ids\s*\? profile_salt\s*:\s*base::StrCat\(\{profile_salt, lobium_media_device_document_salt_\}\)/,
  );
  assert.match(
    addedSource,
    /group_salt = base::StrCat\(\s*\{profile_salt, lobium_media_device_document_salt_, "group_id"\}\)/,
  );
  assert.match(addedSource, /MediaDeviceHmacId\(\s*origin, device_salt,/);
  assert.match(addedSource, /MediaDeviceHmacId\(\s*origin, group_salt,/);

  // enumerateDevices requests native input capabilities. Persona devices must therefore carry the
  // same modest camera/microphone capabilities their labels claim, instead of exposing an empty
  // getCapabilities() dictionary that no real integrated device returns.
  assert.match(addedSource, /VideoInputDeviceCapabilities::New\(\)/);
  assert.match(addedSource, /SetVideoInputCapabilities\(std::move\(video_caps\)\)/);
  assert.match(addedSource, /gfx::Size\(mode\.first, mode\.second\), 30\.0f/);
  assert.match(addedSource, /media::PIXEL_FORMAT_I420/);
  assert.match(addedSource, /AudioInputDeviceCapabilities::New\(\)/);
  assert.match(addedSource, /SetAudioInputCapabilities\(std::move\(audio_caps\)\)/);
  assert.match(addedSource, /audio_caps->channels = 1/);
  assert.match(addedSource, /audio_caps->sample_rate = 48000/);
  assert.match(addedSource, /audio_caps->latency = base::Milliseconds\(10\)/);

  // Exercise the observable relationships with two deterministic stand-ins for independently
  // minted document tokens. The source assertions above bind this oracle to the native formula.
  const id = (origin, salt, kind, index, group = false) => {
    const domain = group ? 'lobium-group-id' : 'lobium-device-id';
    return createHmac('sha256', origin)
      .update(`${domain}\x1f${salt}\x1f${kind}\x1f${index}`)
      .digest('hex');
  };
  const profileSalt = 'profile-salt';
  const documentA = 'document-a';
  const documentB = 'document-b';
  const originA = 'https://a.example';
  const originB = 'https://b.example';
  const deviceSalt = (stable, document) => (stable ? profileSalt : profileSalt + document);
  const groupSalt = (document) => profileSalt + document + 'group_id';

  const unstableA = id(originA, deviceSalt(false, documentA), 'audioinput', 0);
  assert.equal(
    unstableA,
    id(originA, deviceSalt(false, documentA), 'audioinput', 0),
    'one document must return the same unstable deviceId on repeated enumeration',
  );
  assert.notEqual(
    unstableA,
    id(originA, deviceSalt(false, documentB), 'audioinput', 0),
    'unstable deviceId must rotate at the document boundary',
  );
  assert.equal(
    id(originA, deviceSalt(true, documentA), 'audioinput', 0),
    id(originA, deviceSalt(true, documentB), 'audioinput', 0),
    'stable deviceId must remain profile-derived across documents',
  );
  const groupA = id(originA, groupSalt(documentA), 'audio', 0, true);
  assert.equal(
    groupA,
    id(originA, groupSalt(documentA), 'audio', 0, true),
    'one document must return the same groupId on repeated enumeration',
  );
  assert.notEqual(
    groupA,
    id(originA, groupSalt(documentB), 'audio', 0, true),
    'groupId must rotate across documents even when deviceId is stable',
  );
  assert.notEqual(
    id(originA, deviceSalt(true, documentA), 'audioinput', 0),
    id(originB, deviceSalt(true, documentA), 'audioinput', 0),
    'origin must remain part of the HMAC key',
  );
});

test('canvas readback farbling is one-time across every ImageBitmap carrier', async () => {
  const [patch, oracles] = await Promise.all([
    read('lobium/patches/fingerprint/canvas-farbling.patch'),
    read('ci/validation/audit-oracles.mjs'),
  ]);
  const addedSource = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');

  // The core snapshot path calls through CanvasRenderingContext, while the draw provenance lives
  // in Canvas2DRecorderContext. Both halves and the joining override are required to compile and to
  // make the decision from the final concrete 2D context.
  assert.match(addedSource, /virtual bool LobiumHostEntropyDrawn\(\) const \{ return true; \}/);
  assert.match(
    addedSource,
    /bool LobiumHostEntropyDrawn\(\) const override \{\s*return Canvas2DRecorderContext::LobiumHostEntropyDrawn\(\);\s*\}/,
  );
  assert.match(addedSource, /context->LobiumHostEntropyDrawn\(\)/);

  // getImageData exposes rgba-unorm8, rgba-float16, and rgba-float32. All
  // three must share one canonical policy plane or a page can request a float
  // format to recover pristine host pixels. Native float precision is kept
  // everywhere the canonical kernel did not select that exact RGB channel;
  // alpha and values outside finite [0,1] are never projected through q/255.
  assert.doesNotMatch(patch, /\r/, 'canvas patch must remain LF-only');
  assert.match(addedSource, /cfg && cfg->seeds\.canvas && LobiumHostEntropyDrawn\(\)\) \{/);
  assert.match(addedSource, /makeColorType\(kRGBA_8888_SkColorType\)/);
  assert.match(addedSource, /kRGBA_F16_SkColorType[\s\S]*kRGBA_F32_SkColorType/);
  assert.match(addedSource, /for \(size_t channel = 0; channel < 3u; \+\+channel\)/);
  assert.match(addedSource, /pristine_pixel\[channel\] == farbled_pixel\[channel\]/);
  assert.match(addedSource, /bits == 0x8000u \|\| bits <= 0x3c00u/);
  assert.match(addedSource, /std::isfinite\(value\)[\s\S]*value >= 0\.0f[\s\S]*value <= 1\.0f/);
  assert.match(addedSource, /output_channel\.copy_from\(converted_pixel\.subspan/);

  // Every way a decoded/caller-supplied bitmap can acquire a fresh wrapper must retain the false
  // provenance bit. The member defaults true so any unclassified producer stays fail-safe.
  assert.match(addedSource, /bool lobium_host_entropy_ = true/);
  assert.match(addedSource, /LobiumSetHostEntropyProvenance\(bool carries_host_entropy\)/);
  assert.match(addedSource, /lobium_decoded_raster_source = input->IsBitmapImage\(\)/);
  assert.match(addedSource, /lobium_host_entropy_ = !lobium_decoded_raster_source/);
  assert.match(
    addedSource,
    /canvas->HasOffscreenCanvasFrame\(\)[\s\S]*OffscreenCanvasFrame\(\)->LobiumHostEntropyDrawn\(\)/,
  );
  assert.match(addedSource, /ImageData pixels[\s\S]*lobium_host_entropy_ = false/);
  assert.match(
    addedSource,
    /Cropping or transforming a bitmap[\s\S]*lobium_host_entropy_ = bitmap->LobiumCarriesHostEntropy\(\)/,
  );
  assert.match(addedSource, /image_bitmap->LobiumMarkDecodedImageProvenance\(\)/);

  // drawImage and CanvasPattern share one classifier. It recognizes decoded raster images and
  // concrete known-pixel canvas contexts. A transferControlToOffscreen placeholder consumes the
  // immutable frame provenance produced in its worker; unknown producers stay fail-safe. Pattern
  // state is inspected only for the active fill/stroke paint style, so an unused gradient or
  // pattern cannot change another operation's provenance.
  assert.match(addedSource, /bool LobiumSourceCarriesHostEntropy\(/);
  assert.match(addedSource, /IsImageElement\(\)[\s\S]*image->IsBitmapImage\(\)[\s\S]*return false/);
  assert.match(
    addedSource,
    /IsCanvasElement\(\)[\s\S]*HasOffscreenCanvasFrame\(\)[\s\S]*OffscreenCanvasFrame\(\)[\s\S]*LobiumHostEntropyDrawn\(\)/,
  );
  assert.match(addedSource, /bool LobiumCarriesHostEntropy\(\) const/);
  assert.match(
    patch,
    /MakeGarbageCollected<CanvasPattern>[\s\S]*origin_clean,[\s\S]*lobium_host_entropy/,
  );
  assert.match(
    addedSource,
    /LobiumNoteDraw\([\s\S]*PaintType paint_type[\s\S]*state\.Style\(paint_type\)[\s\S]*pattern->LobiumCarriesHostEntropy\(\)/,
  );
  assert.match(
    addedSource,
    /lobium_suppress_image_entropy_ && !StateHasFilter\(\) &&[\s\S]*!GetState\(\)\.ShouldDrawShadows\(\)/,
  );
  assert.match(addedSource, /lobium_force_entropy\(&lobium_force_image_entropy_/);

  // Structured clone has two paths: inline pixels and an attached transfer payload. The transient
  // stream carries the bit in both paths, validates it as a boolean, and defaults old inline values
  // to true. Persistent wire-format-v21 data is deliberately not extended, preserving downgrade
  // compatibility at the cost of the fail-safe default after an IndexedDB round trip.
  assert.match(addedSource, /kLobiumHostEntropyTag = 9/);
  assert.match(addedSource, /kLast = kLobiumHostEntropyTag/);
  assert.match(
    patch,
    /WriteAndRequireInterfaceTag\(kImageBitmapTransferTag\)[\s\S]*WriteUint32\(image_bitmap->LobiumCarriesHostEntropy\(\)\)/,
  );
  assert.match(
    addedSource,
    /if \(!for_storage_\) \{[\s\S]*kLobiumHostEntropyTag[\s\S]*LobiumCarriesHostEntropy/,
  );
  assert.match(addedSource, /uint32_t lobium_host_entropy = 1/);
  assert.match(addedSource, /lobium_host_entropy > 1/);
  assert.match(
    addedSource,
    /transferred_image_bitmaps\[index\][\s\S]*LobiumSetHostEntropyProvenance\(lobium_host_entropy != 0\)/,
  );
  assert.match(
    patch,
    /case ImageSerializationTag::kLobiumHostEntropyTag:[\s\S]*Does not apply to ImageData/,
  );
  assert.match(addedSource, /lobium_host_entropy:uint32_t -> ImageBitmap/);

  // bitmaprenderer owns only a StaticBitmapImage internally, so it needs its own carrier bit while
  // transferFromImageBitmap has consumed the wrapper and transferToImageBitmap creates another one.
  // Its member default is fail-safe: a partially initialized or newly introduced path must not
  // suppress farbling. Known empty/reset pixels explicitly assign false below.
  assert.match(
    patch,
    /Tracks provenance after bitmaprenderer consumes the source wrapper\.[\s\S]*Fail-safe true[\s\S]*bool lobium_host_entropy_ = true/,
  );
  assert.match(
    patch,
    /void ImageBitmapRenderingContext::Stop\(\) \{[\s\S]{0,160}lobium_host_entropy_ = false/,
  );
  assert.match(
    patch,
    /ResetInternalBitmapToBlackTransparent[\s\S]{0,500}lobium_host_entropy_ = false/,
  );
  assert.match(addedSource, /lobium_host_entropy_ = image_bitmap->LobiumCarriesHostEntropy\(\)/);
  assert.match(
    addedSource,
    /const bool lobium_host_entropy = lobium_host_entropy_[\s\S]*LobiumSetHostEntropyProvenance\(lobium_host_entropy\)/,
  );
  assert.match(
    addedSource,
    /bool LobiumHostEntropyDrawn\(\) const override \{ return lobium_host_entropy_; \}/,
  );
  assert.match(
    addedSource,
    /LobiumSetHostEntropyProvenance\(lobium_host_entropy\)[\s\S]*LobiumClearHostEntropyProvenance\(\)/,
  );
  assert.match(
    addedSource,
    /IsRenderingContext2D\(\) \|\|[\s\S]*IsImageBitmapRenderingContext\(\)[\s\S]*LobiumHostEntropyDrawn\(\)/,
  );

  // transferControlToOffscreen leaves the visible HTMLCanvasElement without a rendering context.
  // The exported frame must therefore carry both the worker's provenance bit and the surface that
  // selects canvas-vs-WebGL seed; otherwise direct placeholder toBlob/toDataURL leaks pristine
  // worker raster output.
  assert.match(addedSource, /enum class LobiumReadbackSurface/);
  assert.match(addedSource, /const LobiumReadbackSurface lobium_readback_surface_/);
  assert.match(addedSource, /const bool lobium_host_entropy_drawn_/);
  assert.match(
    addedSource,
    /MakeRefCounted<ExportedCanvasResource>[\s\S]*lobium_readback_surface,[\s\S]*context_->LobiumHostEntropyDrawn\(\)/,
  );
  assert.match(
    addedSource,
    /HasOffscreenCanvasFrame\(\)[\s\S]*LobiumReadbackSurfaceType\(\)[\s\S]*kCanvas[\s\S]*seeds\.canvas[\s\S]*kWebGL[\s\S]*seeds\.webgl/,
  );

  // Bind the source contract to a shipping detector for every public carrier rather than relying on
  // static text alone.
  assert.match(oracles, /imageElement: read\(imageElement\)/);
  assert.match(oracles, /canvas: read\(c\)/);
  assert.match(oracles, /const copied = await createImageBitmap\(bmp\)/);
  assert.match(oracles, /const cloned = structuredClone\(bmp\)/);
  assert.match(oracles, /createPattern\(await createImageBitmap\(bmp\), 'no-repeat'\)/);
  assert.match(oracles, /worker\.postMessage\(transferSource, \[transferSource\]\)/);
  assert.match(oracles, /getContext\('bitmaprenderer'\)/);
  assert.match(oracles, /variants\.bitmapRenderer = read\(bitmapRenderer\)/);
  assert.match(oracles, /variants\.offscreenTransfer = read\(offscreenTransfer\)/);
  assert.match(oracles, /transferControlToOffscreen\(\)/);
  assert.match(oracles, /placeholder\.toBlob/);
  assert.match(oracles, /id: 'canvas-float-readback-coherent'/);
  assert.match(oracles, /rgba-unorm8[\s\S]*rgba-float16[\s\S]*rgba-float32/);
  assert.match(oracles, /full-vs-1x1/);
  assert.match(oracles, /read-put-read/);
  assert.match(oracles, /range-guard/);
});

test('navigator.webdriver is a separately capability-gated native hook', async () => {
  const [patch, nativeSource, contract] = await Promise.all([
    read('lobium/patches/fingerprint/navigator-webdriver.patch'),
    read('lobium/src/lobium_capabilities.cc'),
    read('packages/engine-runner/src/lobium-capabilities.ts'),
  ]);
  assert.match(patch, /bool Navigator::webdriver\(\) const/);
  assert.match(patch, /lobium::LobiumFpConfig::Current\(\)/);
  assert.match(patch, /return false/);
  assert.match(nativeSource, /^\s*"navigator-webdriver",\s*$/m);
  assert.match(contract, /'navigator-webdriver'/);
});

test('IntersectionObserver exposes one coherent farbled geometry tuple', async () => {
  const patch = await read('lobium/patches/fingerprint/client-rects.patch');
  const addedSource = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');

  // Explicit Element roots expose a layout-derived rootBounds alongside the two target rectangles.
  // It must use its own style policy and the same seed; implicit viewport/Document roots stay exact.
  assert.match(
    addedSource,
    /!RootIsImplicit\(\)[\s\S]*DynamicTo<Element>\(root->GetNode\(\)\)[\s\S]*farble_for_element\(root_rect_, \*root_element\)/,
  );

  // Upstream computes the ratio and threshold before the presentation rectangles are farbled. The
  // patch must overwrite both fields after every exposed rect mutation, using the exposed target or
  // root area as the matching denominator.
  const rectFarbleOffsets = [
    addedSource.indexOf('farble_for_element(target_rect_'),
    addedSource.indexOf('farble_for_element(intersection_rect_'),
    addedSource.indexOf('farble_for_element(root_rect_'),
  ];
  assert.ok(
    rectFarbleOffsets.every((offset) => offset >= 0),
    'target, intersection, and explicit-root rectangles must all be covered',
  );
  const lastRectFarble = Math.max(...rectFarbleOffsets);
  const ratioRecompute = addedSource.indexOf(
    'const float intersection_area = intersection_rect_.size().GetArea()',
  );
  const thresholdRecompute = addedSource.indexOf(
    'FirstThresholdGreaterThan(intersection_ratio_, thresholds)',
  );
  assert.ok(
    ratioRecompute > lastRectFarble,
    'ratio must be recomputed after exposed rect farbling',
  );
  assert.ok(
    thresholdRecompute > ratioRecompute,
    'threshold index must be recomputed from the exposed intersection ratio',
  );
  assert.match(addedSource, /ShouldTrackFractionOfRoot\(\) \? root_rect_ : target_rect_/);
  assert.match(
    addedSource,
    /intersection_ratio_ =\s*std::min\(intersection_area \/ area_of_interest, 1\.f\)/,
  );
});

test('WebGPU required limits cannot exceed the final exposed adapter snapshot', async () => {
  const [patch, oracles] = await Promise.all([
    read('lobium/patches/fingerprint/webgpu-adapter.patch'),
    read('ci/validation/audit-oracles.mjs'),
  ]);
  const addedSource = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');

  const maximumLimits = [
    'maxTextureDimension1D',
    'maxTextureDimension2D',
    'maxTextureDimension3D',
    'maxTextureArrayLayers',
    'maxBindGroups',
    'maxBindGroupsPlusVertexBuffers',
    'maxBindingsPerBindGroup',
    'maxDynamicUniformBuffersPerPipelineLayout',
    'maxDynamicStorageBuffersPerPipelineLayout',
    'maxSampledTexturesPerShaderStage',
    'maxSamplersPerShaderStage',
    'maxStorageBuffersPerShaderStage',
    'maxStorageTexturesPerShaderStage',
    'maxUniformBuffersPerShaderStage',
    'maxUniformBufferBindingSize',
    'maxStorageBufferBindingSize',
    'maxVertexBuffers',
    'maxBufferSize',
    'maxVertexAttributes',
    'maxVertexBufferArrayStride',
    'maxInterStageShaderVariables',
    'maxColorAttachments',
    'maxColorAttachmentBytesPerSample',
    'maxComputeWorkgroupStorageSize',
    'maxComputeInvocationsPerWorkgroup',
    'maxComputeWorkgroupSizeX',
    'maxComputeWorkgroupSizeY',
    'maxComputeWorkgroupSizeZ',
    'maxComputeWorkgroupsPerDimension',
    'maxStorageBuffersInFragmentStage',
    'maxStorageTexturesInFragmentStage',
    'maxStorageBuffersInVertexStage',
    'maxStorageTexturesInVertexStage',
    'maxImmediateSize',
  ];
  const alignmentLimits = ['minUniformBufferOffsetAlignment', 'minStorageBufferOffsetAlignment'];
  const checkedMaximums = [
    ...addedSource.matchAll(/^\s*LOBIUM_VALIDATE_MAXIMUM_LIMIT\((\w+),/gm),
  ].map((match) => match[1]);
  const checkedAlignments = [
    ...addedSource.matchAll(/^\s*LOBIUM_VALIDATE_ALIGNMENT_LIMIT\((\w+)\)/gm),
  ].map((match) => match[1]);
  assert.deepEqual(checkedMaximums, maximumLimits);
  assert.deepEqual(checkedAlignments, alignmentLimits);
  assert.match(addedSource, /required\.name > advertised->name\(\)/);
  assert.match(addedSource, /required\.name < advertised->name\(\)/);
  assert.match(addedSource, /DOMExceptionCode::kOperationError/);

  const requestHunk = patch.slice(patch.indexOf('@@ -260'));
  const populatedOrRejected = requestHunk.indexOf('return promise;');
  const exposedLimitCheck = requestHunk.indexOf(
    'ValidateRequiredLimitsAgainstAdvertised(required_limits',
  );
  const dawnBoundary = requestHunk.indexOf('// Use a set to prevent duplicate features.');
  assert.ok(populatedOrRejected >= 0 && populatedOrRejected < exposedLimitCheck);
  assert.ok(
    exposedLimitCheck < dawnBoundary,
    'all exposed-limit checks must run before Dawn device creation',
  );

  // Exercise the production detector path: it asks for the claimed maximum plus one and requires
  // the WebGPU-mandated OperationError. A stronger real adapter must never make this request pass.
  const detector = oracles.slice(
    oracles.indexOf("id: 'webgpu-adapter-matches-webgl-renderer'"),
    oracles.indexOf("id: 'mediadevices-ids-have-chrome-shape'"),
  );
  assert.match(detector, /claimedMaxBufferSize = adapter\.limits\.maxBufferSize/);
  assert.match(detector, /requiredLimits:\s*\{ maxBufferSize: claimedMaxBufferSize \+ 1 \}/);
  assert.match(detector, /error\?\.name !== 'OperationError'/);
});

test('production native detector no longer installs the compatibility overlay', async () => {
  const detector = await read('ci/validation/lobium-detect.mjs');
  assert.doesNotMatch(detector, /applyCdpFingerprint/);
  assert.match(detector, /probeLobiumBuildCapabilities/);

  const probe = await read('ci/validation/native-policy-probe.mjs');
  for (const context of ['iframe', 'worker', 'shared', 'service']) {
    assert.ok(probe.includes(context), `native probe missing ${context} context`);
  }
  assert.match(probe, /clientRectsDistinct/);
  assert.match(probe, /mediaIdsDistinct/);
});
