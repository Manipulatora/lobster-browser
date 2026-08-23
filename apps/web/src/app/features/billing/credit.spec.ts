import { formatCredit } from './credit';

describe('formatCredit', () => {
  it('renders integer wire cents as a two-decimal Credit balance', () => {
    expect(formatCredit(0)).toBe('0.00 Credit');
    expect(formatCredit(1)).toBe('0.01 Credit');
    expect(formatCredit(1_234)).toBe('12.34 Credit');
  });

  it('keeps signed ledger adjustments visible', () => {
    expect(formatCredit(-250)).toBe('-2.50 Credit');
  });
});
