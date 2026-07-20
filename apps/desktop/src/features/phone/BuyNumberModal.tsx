import { useState } from 'react';

import type { AvailableNumber, OwnedNumber, PhoneNumberType } from '@lobster/shared-types';

import { Button, Input, Modal, Select, Spinner } from '../../ui';
import { phoneClient } from './phoneApi';
import { COUNTRIES, NUMBER_TYPES, formatNumber } from './phoneOptions';

/**
 * Buy a number: pick a country + type (+ optional area code / pattern), search Twilio's inventory, and
 * purchase one. On success the number's webhooks are already pointed at the backend, so it can send/
 * receive immediately (subject to SMS registration in some countries).
 */
export function BuyNumberModal({
  open,
  onClose,
  onPurchased,
}: {
  open: boolean;
  onClose: () => void;
  onPurchased: (n: OwnedNumber) => void;
}): JSX.Element {
  const [country, setCountry] = useState('US');
  const [type, setType] = useState<PhoneNumberType>('local');
  const [areaCode, setAreaCode] = useState('');
  const [contains, setContains] = useState('');
  const [results, setResults] = useState<AvailableNumber[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [buyingNumber, setBuyingNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedCountry = COUNTRIES.find((c) => c.iso === country);

  async function search(): Promise<void> {
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const found = await phoneClient.searchNumbers({
        country,
        type,
        ...(areaCode.trim() ? { areaCode: areaCode.trim() } : {}),
        ...(contains.trim() ? { contains: contains.trim() } : {}),
        limit: 30,
      });
      setResults(found);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  async function buy(n: AvailableNumber): Promise<void> {
    setBuyingNumber(n.phoneNumber);
    setError(null);
    try {
      const owned = await phoneClient.buyNumber(n.phoneNumber);
      onPurchased(owned);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuyingNumber(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Buy a number" size="lg">
      <div className="buy-number">
        <div className="buy-number__filters">
          <Select label="Country" value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map((c) => (
              <option key={c.iso} value={c.iso}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select
            label="Type"
            value={type}
            onChange={(e) => setType(e.target.value as PhoneNumberType)}
          >
            {NUMBER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          <Input
            label="Area code"
            placeholder="optional"
            value={areaCode}
            onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ''))}
          />
          <Input
            label="Contains"
            placeholder="digits/letters"
            value={contains}
            onChange={(e) => setContains(e.target.value)}
          />
          <div className="buy-number__search">
            <Button variant="primary" onClick={() => void search()} disabled={searching}>
              {searching ? 'Searching…' : 'Search'}
            </Button>
          </div>
        </div>

        {selectedCountry && !selectedCountry.instant ? (
          <p className="notice notice--info">
            {selectedCountry.name} numbers usually require a regulatory bundle / local address before
            Twilio will release them — a purchase may be rejected until that's cleared.
          </p>
        ) : null}

        {error ? (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="buy-number__results">
          {searching ? (
            <div className="buy-number__loading">
              <Spinner /> Searching Twilio inventory…
            </div>
          ) : results && results.length === 0 ? (
            <p className="field-hint">No numbers matched — try a different area code or type.</p>
          ) : results ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Location</th>
                  <th>Capabilities</th>
                  <th>Price/mo</th>
                  <th aria-label="Buy" />
                </tr>
              </thead>
              <tbody>
                {results.map((n) => (
                  <tr key={n.phoneNumber}>
                    <td>{formatNumber(n.phoneNumber)}</td>
                    <td>{[n.locality, n.region].filter(Boolean).join(', ') || n.isoCountry}</td>
                    <td>
                      {[
                        n.capabilities.voice && 'Voice',
                        n.capabilities.sms && 'SMS',
                        n.capabilities.mms && 'MMS',
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                    <td>{n.monthlyPrice ? `${n.monthlyPrice} ${n.priceUnit ?? ''}` : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Button
                        variant="secondary"
                        onClick={() => void buy(n)}
                        disabled={buyingNumber !== null}
                      >
                        {buyingNumber === n.phoneNumber ? 'Buying…' : 'Buy'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="field-hint">Choose a country and search to see available numbers.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
