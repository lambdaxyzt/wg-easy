import { describe, expect, test } from 'vitest';

import { currentPeriodStart } from '#server/utils/quota';

// Own file: changing TZ can't be undone reliably on every platform
process.env.TZ = 'Europe/Berlin';

describe('quota periods across DST (Europe/Berlin)', () => {
  test('daily reset stays at the same wall clock time after spring forward', () => {
    // DST starts 2026-03-29 02:00 -> 03:00
    const anchor = new Date(2026, 2, 27, 8, 0);
    const start = currentPeriodStart(
      anchor,
      'day',
      new Date(2026, 2, 30, 9, 0)
    );
    expect(start).toEqual(new Date(2026, 2, 30, 8, 0));
  });

  test('daily reset stays at the same wall clock time after fall back', () => {
    // DST ends 2026-10-25 03:00 -> 02:00
    const anchor = new Date(2026, 9, 24, 8, 0);
    const start = currentPeriodStart(
      anchor,
      'day',
      new Date(2026, 9, 25, 8, 30)
    );
    expect(start).toEqual(new Date(2026, 9, 25, 8, 0));
  });

  test('a period is not reset early during the 25 hour day', () => {
    const anchor = new Date(2026, 9, 24, 8, 0);
    // Oct 24 08:00 -> Oct 25 08:00 is 25h; after 24h it is only 07:00 local
    const now = new Date(anchor.getTime() + 24 * 3_600_000);
    expect(now.getHours()).toBe(7);
    expect(currentPeriodStart(anchor, 'day', now)).toEqual(anchor);
  });
});
