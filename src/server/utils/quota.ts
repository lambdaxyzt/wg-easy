import type { ClientType, QuotaPeriod } from '#db/repositories/client/types';

type ResetPeriod = Exclude<QuotaPeriod, 'none'>;

export type QuotaClient = Pick<
  ClientType,
  | 'quotaLimit'
  | 'quotaPeriod'
  | 'quotaUsed'
  | 'quotaAnchor'
  | 'quotaPeriodStart'
  | 'quotaExceeded'
>;

export type QuotaAction =
  | { type: 'reset'; periodStart: Date }
  | { type: 'block' }
  | { type: 'unblock' }
  | null;

/**
 * Bytes transferred since the last reading.
 *
 * WireGuard counters start at 0 when a peer is (re)added or the interface
 * restarts, so a missing or larger previous value means the counter was reset.
 */
export function computeDelta(previous: number | undefined, current: number) {
  if (previous === undefined || current < previous) {
    return current;
  }
  return current - previous;
}

/**
 * The n-th reset boundary after `anchor`, in the server's local time.
 *
 * Uses calendar arithmetic so DST changes don't shift the reset time, and
 * clamps monthly resets to the month length while keeping the anchor day
 * (Jan 31 -> Feb 28 -> Mar 31).
 */
export function periodBoundary(anchor: Date, period: ResetPeriod, n: number) {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const day = anchor.getDate();
  const time = [
    anchor.getHours(),
    anchor.getMinutes(),
    anchor.getSeconds(),
    anchor.getMilliseconds(),
  ] as const;

  switch (period) {
    case 'day':
      return new Date(year, month, day + n, ...time);
    case 'week':
      return new Date(year, month, day + 7 * n, ...time);
    case 'month': {
      const daysInMonth = new Date(year, month + n + 1, 0).getDate();
      return new Date(year, month + n, Math.min(day, daysInMonth), ...time);
    }
  }
}

/**
 * Start of the period that contains `now`. Missed periods (e.g. while the
 * server was down) collapse into the latest one.
 */
export function currentPeriodStart(
  anchor: Date,
  period: ResetPeriod,
  now: Date
) {
  if (now < anchor) {
    return anchor;
  }

  const elapsed = now.getTime() - anchor.getTime();
  let n: number;
  switch (period) {
    case 'day':
      n = Math.floor(elapsed / 86_400_000);
      break;
    case 'week':
      n = Math.floor(elapsed / 604_800_000);
      break;
    case 'month':
      n =
        (now.getFullYear() - anchor.getFullYear()) * 12 +
        (now.getMonth() - anchor.getMonth());
      break;
  }

  // the estimate can be off by one around DST changes and month ends
  while (n > 0 && periodBoundary(anchor, period, n) > now) n--;
  while (periodBoundary(anchor, period, n + 1) <= now) n++;

  return periodBoundary(anchor, period, n);
}

/**
 * Decide what the quota check has to do for a client.
 */
export function evaluateQuota(client: QuotaClient, now: Date): QuotaAction {
  if (client.quotaLimit === null) {
    return client.quotaExceeded ? { type: 'unblock' } : null;
  }

  if (client.quotaPeriod !== 'none' && client.quotaAnchor !== null) {
    const periodStart = currentPeriodStart(
      new Date(client.quotaAnchor),
      client.quotaPeriod,
      now
    );
    if (
      client.quotaPeriodStart === null ||
      periodStart > new Date(client.quotaPeriodStart)
    ) {
      return { type: 'reset', periodStart };
    }
  }

  if (client.quotaUsed >= client.quotaLimit) {
    return client.quotaExceeded ? null : { type: 'block' };
  }

  return client.quotaExceeded ? { type: 'unblock' } : null;
}
