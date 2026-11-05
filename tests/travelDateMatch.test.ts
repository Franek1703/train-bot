import { describe, expect, it } from 'vitest';
import { mentionsTravelDate } from '../src/purchases/intercityPaymentPage.js';

describe('mentionsTravelDate', () => {
  it('matches the zero-padded single-digit day Intercity prints (regression: 06 listopada)', () => {
    expect(mentionsTravelDate('PIĄTEK, 06 LISTOPADA 15:37 Warszawa Zach.', new Date('2026-11-06T00:00:00Z'))).toBe(true);
    expect(mentionsTravelDate('CZWARTEK, 05 LISTOPADA', new Date('2026-11-05T00:00:00Z'))).toBe(true);
  });

  it('still matches an unpadded single-digit day', () => {
    expect(mentionsTravelDate('6 listopada', new Date('2026-11-06T00:00:00Z'))).toBe(true);
  });

  it('keeps matching two-digit days', () => {
    expect(mentionsTravelDate('NIEDZIELA, 11 PAŹDZIERNIKA', new Date('2026-10-11T00:00:00Z'))).toBe(true);
    expect(mentionsTravelDate('10 października', new Date('2026-10-10T00:00:00Z'))).toBe(true);
  });

  it('rejects a different day, even when the digit is a suffix of a two-digit day', () => {
    expect(mentionsTravelDate('PIĄTEK, 06 LISTOPADA', new Date('2026-11-05T00:00:00Z'))).toBe(false);
    expect(mentionsTravelDate('16 LISTOPADA', new Date('2026-11-06T00:00:00Z'))).toBe(false);
    expect(mentionsTravelDate('26 listopada', new Date('2026-11-06T00:00:00Z'))).toBe(false);
    expect(mentionsTravelDate('1 listopada', new Date('2026-11-11T00:00:00Z'))).toBe(false);
  });

  it('rejects a different month', () => {
    expect(mentionsTravelDate('06 PAŹDZIERNIKA', new Date('2026-11-06T00:00:00Z'))).toBe(false);
  });
});
