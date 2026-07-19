/**
 * @lobster/android-machine — per-profile isolated Android machines (AVD/QEMU) running Lobium Android,
 * an AOSP fork whose framework sandboxes apps on install by default (the "Island" capability).
 *
 * - The OS feature itself is the framework fork under `aosp/` (system service + patches + sepolicy);
 *   there is no isolation app — sandboxing is compiled into the OS.
 * - The golden-image build (from that fork) + per-machine policy staging live under `image/`.
 * - The host-side lifecycle (below) is the contract the desktop core drives on a KVM+GPU host.
 */
export { AvdMachineRunner, buildPropsFor } from './machine-lifecycle.js';
export type { MobileMachineRunner } from './machine-lifecycle.js';
