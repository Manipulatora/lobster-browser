import type { PhoneNumberType, SupportedCountry } from '@lobster/shared-types';

/**
 * Countries offered in the buy-number picker. `instant` marks the ones Twilio provisions immediately;
 * the others typically need a regulatory bundle / local-address proof first, so we flag them so the
 * user isn't surprised by a rejected purchase. This is a practical shortlist, not Twilio's full list.
 */
export const COUNTRIES: readonly SupportedCountry[] = [
  { iso: 'US', name: 'United States', instant: true },
  { iso: 'CA', name: 'Canada', instant: true },
  { iso: 'GB', name: 'United Kingdom', instant: true },
  { iso: 'NL', name: 'Netherlands', instant: true },
  { iso: 'AU', name: 'Australia', instant: false },
  { iso: 'DE', name: 'Germany', instant: false },
  { iso: 'FR', name: 'France', instant: false },
  { iso: 'ES', name: 'Spain', instant: false },
  { iso: 'IT', name: 'Italy', instant: false },
  { iso: 'SE', name: 'Sweden', instant: true },
  { iso: 'PL', name: 'Poland', instant: true },
  { iso: 'IE', name: 'Ireland', instant: true },
  { iso: 'PR', name: 'Puerto Rico', instant: true },
  { iso: 'MX', name: 'Mexico', instant: false },
  { iso: 'BE', name: 'Belgium', instant: false },
];

export const NUMBER_TYPES: readonly { value: PhoneNumberType; label: string }[] = [
  { value: 'local', label: 'Local' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'tollFree', label: 'Toll-free' },
];

export function countryName(iso: string): string {
  return COUNTRIES.find((c) => c.iso === iso.toUpperCase())?.name ?? iso;
}

/** Light-touch display formatting for E.164 (keeps it readable without a full libphonenumber dep). */
export function formatNumber(e164: string): string {
  if (/^\+1\d{10}$/.test(e164)) {
    const d = e164.slice(2);
    return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return e164;
}

/** ms-duration → m:ss for the in-call timer. */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
