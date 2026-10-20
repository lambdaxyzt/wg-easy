import { describe, expect, test } from 'vitest';

import { AsyncMutex } from '#server/utils/AsyncMutex';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('AsyncMutex', () => {
  test('runs functions one at a time in call order', async () => {
    const mutex = new AsyncMutex();
    const events: string[] = [];

    await Promise.all([
      mutex.run(async () => {
        events.push('a start');
        await sleep(20);
        events.push('a end');
      }),
      mutex.run(async () => {
        events.push('b start');
        events.push('b end');
      }),
    ]);

    expect(events).toEqual(['a start', 'a end', 'b start', 'b end']);
  });

  test('keeps working after a rejected function', async () => {
    const mutex = new AsyncMutex();

    await expect(
      mutex.run(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    await expect(mutex.run(async () => 42)).resolves.toBe(42);
  });
});
