import type { AndroidApiLevel, AndroidMachineType } from '@lobster/shared-types';

/** Human labels for the Android device classes a machine can present. */
export const MACHINE_TYPE_OPTIONS: ReadonlyArray<{ value: AndroidMachineType; label: string }> = [
  { value: 'pixel_8_pro', label: 'Google Pixel 8 Pro' },
  { value: 'pixel_8', label: 'Google Pixel 8' },
  { value: 'pixel_7', label: 'Google Pixel 7' },
  { value: 'pixel_6a', label: 'Google Pixel 6a' },
  { value: 'samsung_galaxy_s23', label: 'Samsung Galaxy S23' },
  { value: 'samsung_galaxy_s22', label: 'Samsung Galaxy S22' },
  { value: 'samsung_galaxy_a54', label: 'Samsung Galaxy A54' },
  { value: 'xiaomi_13', label: 'Xiaomi 13' },
  { value: 'oneplus_11', label: 'OnePlus 11' },
  { value: 'generic_phone', label: 'Generic phone' },
];

/** API level ↔ Android release label. */
export const API_LEVEL_OPTIONS: ReadonlyArray<{ value: AndroidApiLevel; label: string }> = [
  { value: 34, label: 'Android 14 (API 34)' },
  { value: 33, label: 'Android 13 (API 33)' },
  { value: 32, label: 'Android 12L (API 32)' },
  { value: 31, label: 'Android 12 (API 31)' },
  { value: 30, label: 'Android 11 (API 30)' },
];

export function machineTypeLabel(value: AndroidMachineType): string {
  return MACHINE_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function apiLevelLabel(value: AndroidApiLevel): string {
  return API_LEVEL_OPTIONS.find((o) => o.value === value)?.label ?? `API ${value}`;
}

/**
 * Common account-holding apps that Island isolates BY DEFAULT on install (secure app install +
 * account protection). Pre-checked in the create form; the user can adjust per machine.
 */
export const SUGGESTED_ISOLATED_APPS: ReadonlyArray<{ pkg: string; label: string }> = [
  { pkg: 'com.microsoft.office.outlook', label: 'Outlook' },
  { pkg: 'com.google.android.gm', label: 'Gmail' },
  { pkg: 'com.instagram.android', label: 'Instagram' },
  { pkg: 'com.facebook.katana', label: 'Facebook' },
  { pkg: 'com.twitter.android', label: 'X / Twitter' },
  { pkg: 'com.whatsapp', label: 'WhatsApp' },
  { pkg: 'com.github.android', label: 'GitHub' },
];
