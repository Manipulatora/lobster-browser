/**
 * @lobster/android-machine — per-profile isolated Android machines (AVD/QEMU) with the built-in
 * Lobium Island isolation service.
 *
 * - The Island app itself is developed under `island-app/` (Kotlin) and baked into the golden image.
 * - The golden-image build + first-boot provisioning live under `image/`.
 * - The host-side lifecycle (below) is the contract the desktop core drives on a KVM+GPU host.
 */
export { AvdMachineRunner, buildPropsFor } from './machine-lifecycle.js';
export type { MobileMachineRunner } from './machine-lifecycle.js';
