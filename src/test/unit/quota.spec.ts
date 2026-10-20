import { describe, expect, test } from 'vitest';

import {
  computeDelta,
  currentPeriodStart,
  evaluateQuota,
  periodBoundary,
  type QuotaClient,
} from '#server/utils/quota';

const local = (...args: [number, number, number, number?, number?]) =>
  new Date(args[0], args[1] - 1, args[2], args[3] ?? 0, args[4] ?? 0);

describe('computeDelta', () => {
  test('returns the difference to the previous reading', () => {
    expect(computeDelta(100, 250)).toBe(150);
  });

  test('returns 0 when nothing changed', () => {
    expect(computeDelta(250, 250)).toBe(0);
  });

  test('counts from 0 when the counter was reset', () => {
    expect(computeDelta(1000, 40)).toBe(40);
  });

  test('counts everything for a peer without baseline', () => {
    expect(computeDelta(undefined, 70)).toBe(70);
  });
});

describe('periodBoundary', () => {
  test('monthly resets keep the anchor day after short months', () => {
    const anchor = local(2026, 1, 31, 8, 30);
    expect(periodBoundary(anchor, 'month', 1)).toEqual(
      local(2026, 2, 28, 8, 30)
    );
    expect(periodBoundary(anchor, 'month', 2)).toEqual(
      local(2026, 3, 31, 8, 30)
    );
    expect(periodBoundary(anchor, 'month', 3)).toEqual(
      local(2026, 4, 30, 8, 30)
    );
  });

  test('monthly resets use Feb 29 in leap years', () => {
    expect(periodBoundary(local(2028, 1, 30), 'month', 1)).toEqual(
      local(2028, 2, 29)
    );
  });

  test('daily and weekly resets add calendar days', () => {
    const anchor = local(2026, 12, 30, 23, 0);
    expect(periodBoundary(anchor, 'day', 2)).toEqual(local(2027, 1, 1, 23, 0));
    expect(periodBoundary(anchor, 'week', 1)).toEqual(local(2027, 1, 6, 23, 0));
  });
});

describe('currentPeriodStart', () => {
  test('returns the anchor during the first period', () => {
    const anchor = local(2026, 5, 10, 12, 0);
    expect(
      currentPeriodStart(anchor, 'day', local(2026, 5, 11, 11, 59))
    ).toEqual(anchor);
  });

  test('collapses missed periods into the latest one', () => {
    const anchor = local(2026, 1, 15);
    expect(currentPeriodStart(anchor, 'month', local(2026, 7, 20))).toEqual(
      local(2026, 7, 15)
    );
  });

  test('switches exactly at the boundary', () => {
    const anchor = local(2026, 3, 1, 6, 0);
    expect(currentPeriodStart(anchor, 'week', local(2026, 3, 8, 6, 0))).toEqual(
      local(2026, 3, 8, 6, 0)
    );
    expect(
      currentPeriodStart(
        anchor,
        'week',
        new Date(local(2026, 3, 8, 6, 0).getTime() - 1)
      )
    ).toEqual(anchor);
  });

  test('handles now before the anchor', () => {
    const anchor = local(2026, 3, 1);
    expect(currentPeriodStart(anchor, 'day', local(2026, 2, 1))).toEqual(
      anchor
    );
  });
});

describe('evaluateQuota', () => {
  const now = local(2026, 6, 15, 12, 0);
  const base: QuotaClient = {
    quotaLimit: 1000,
    quotaPeriod: 'none',
    quotaUsed: 0,
    quotaAnchor: local(2026, 6, 1).toISOString(),
    quotaPeriodStart: local(2026, 6, 1).toISOString(),
    quotaExceeded: false,
  };

  test('does nothing below the limit', () => {
    expect(evaluateQuota({ ...base, quotaUsed: 999 }, now)).toBeNull();
  });

  test('blocks at the limit', () => {
    expect(evaluateQuota({ ...base, quotaUsed: 1000 }, now)).toEqual({
      type: 'block',
    });
  });

  test('does not block twice', () => {
    expect(
      evaluateQuota({ ...base, quotaUsed: 5000, quotaExceeded: true }, now)
    ).toBeNull();
  });

  test('unblocks when the limit was raised or removed', () => {
    expect(
      evaluateQuota({ ...base, quotaUsed: 500, quotaExceeded: true }, now)
    ).toEqual({ type: 'unblock' });
    expect(
      evaluateQuota({ ...base, quotaLimit: null, quotaExceeded: true }, now)
    ).toEqual({ type: 'unblock' });
  });

  test('starts a new period before checking the limit', () => {
    expect(
      evaluateQuota(
        {
          ...base,
          quotaPeriod: 'week',
          quotaUsed: 5000,
          quotaExceeded: true,
        },
        now
      )
    ).toEqual({ type: 'reset', periodStart: local(2026, 6, 15) });
  });

  test('ignores clients without quota', () => {
    expect(evaluateQuota({ ...base, quotaLimit: null }, now)).toBeNull();
  });
});
