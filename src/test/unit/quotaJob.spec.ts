import fs from 'node:fs/promises';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import WireGuard from '#server/utils/WireGuard';
import { wg } from '#server/utils/wgHelper';

type FakeClient = {
  id: number;
  publicKey: string;
  enabled: boolean;
  quotaLimit: number | null;
  quotaPeriod: 'none' | 'day' | 'week' | 'month';
  quotaUsed: number;
  quotaAnchor: string | null;
  quotaPeriodStart: string | null;
  quotaExceeded: boolean;
};

const state = vi.hoisted(() => ({
  clients: [] as FakeClient[],
  counters: new Map<string, number>(),
}));

vi.mock('node:fs/promises', () => ({
  default: { writeFile: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('#server/utils/config', () => ({
  WG_ENV: { DISABLE_IPV6: true },
  OLD_ENV: {},
}));

vi.mock('#server/utils/firewall', () => ({
  firewall: { rebuildRules: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('#server/utils/qr', () => ({ encodeQRCode: vi.fn() }));

vi.mock('#shared/utils/time', () => ({ setIntervalImmediately: vi.fn() }));

vi.mock('#server/utils/wgHelper', () => ({
  wg: {
    generateServerInterface: vi.fn(() => '[Interface]'),
    generateServerPeer: vi.fn(
      (client: FakeClient) => `[Peer]\nPublicKey = ${client.publicKey}`
    ),
    sync: vi.fn().mockResolvedValue(''),
    // only active peers exist in the kernel
    dump: vi.fn(async () =>
      state.clients
        .filter((c) => c.enabled && !c.quotaExceeded)
        .map((c) => ({
          publicKey: c.publicKey,
          transferRx: state.counters.get(c.publicKey) ?? 0,
          transferTx: 0,
        }))
    ),
  },
}));

vi.mock('#server/utils/Database', () => {
  const find = (id: number) => state.clients.find((c) => c.id === id)!;
  return {
    default: {
      interfaces: { get: vi.fn(async () => ({ name: 'wg0' })) },
      hooks: { get: vi.fn(async () => ({})) },
      userConfigs: { get: vi.fn(async () => ({})) },
      clients: {
        getAll: vi.fn(async () => state.clients.map((c) => ({ ...c }))),
        get: vi.fn(async (id: number) => ({ ...find(id) })),
        addQuotaUsage: vi.fn(async (usage: { id: number; bytes: number }[]) => {
          for (const { id, bytes } of usage) find(id).quotaUsed += bytes;
        }),
        setQuotaExceeded: vi.fn(async (id: number, value: boolean) => {
          find(id).quotaExceeded = value;
        }),
        resetQuotaUsage: vi.fn(async (id: number, periodStart?: Date) => {
          const client = find(id);
          client.quotaUsed = 0;
          client.quotaExceeded = false;
          if (periodStart) client.quotaPeriodStart = periodStart.toISOString();
        }),
        setQuota: vi.fn(
          async (
            id: number,
            q: {
              quotaLimit: number | null;
              quotaPeriod: FakeClient['quotaPeriod'];
            }
          ) => {
            Object.assign(find(id), q, { quotaUsed: 0, quotaExceeded: false });
          }
        ),
      },
    },
  };
});

const writeFileMock = vi.mocked(fs.writeFile);
const dumpMock = vi.mocked(wg.dump);

function client(id: number, overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    id,
    publicKey: `key${id}`,
    enabled: true,
    quotaLimit: null,
    quotaPeriod: 'none',
    quotaUsed: 0,
    quotaAnchor: null,
    quotaPeriodStart: null,
    quotaExceeded: false,
    ...overrides,
  };
}

const lastConfig = () => String(writeFileMock.mock.lastCall?.[1] ?? '');

describe('quota job', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.clients = [];
    state.counters.clear();
    // drop baselines from previous tests
    await WireGuard.checkQuotas();
  });

  test('skips reading counters when no client has a quota', async () => {
    state.clients = [client(1)];
    await WireGuard.checkQuotas();
    expect(dumpMock).not.toHaveBeenCalled();
  });

  test('counts only new bytes on every check', async () => {
    state.clients = [client(1, { quotaLimit: 10_000 })];

    state.counters.set('key1', 100);
    await WireGuard.checkQuotas();
    state.counters.set('key1', 250);
    await WireGuard.checkQuotas();
    await WireGuard.checkQuotas();

    expect(state.clients[0]!.quotaUsed).toBe(250);
  });

  test('does not count traffic from before the quota was set', async () => {
    state.clients = [client(1, { quotaLimit: 10_000 }), client(2)];
    state.counters.set('key2', 5000);
    await WireGuard.checkQuotas();

    await WireGuard.setClientQuota(2, {
      quotaLimit: 10_000,
      quotaPeriod: 'none',
    });
    state.counters.set('key2', 5300);
    await WireGuard.checkQuotas();

    expect(state.clients[1]!.quotaUsed).toBe(300);
  });

  test('blocks at the limit and removes the peer from the config', async () => {
    state.clients = [client(1, { quotaLimit: 1000 }), client(2)];

    state.counters.set('key1', 1200);
    await WireGuard.checkQuotas();

    expect(state.clients[0]!.quotaExceeded).toBe(true);
    expect(state.clients[0]!.enabled).toBe(true);
    expect(lastConfig()).not.toContain('key1');
    expect(lastConfig()).toContain('key2');
  });

  test('counts a reset counter from 0', async () => {
    state.clients = [client(1, { quotaLimit: 100_000 })];

    state.counters.set('key1', 5000);
    await WireGuard.checkQuotas();
    state.counters.set('key1', 300); // interface restarted
    await WireGuard.checkQuotas();

    expect(state.clients[0]!.quotaUsed).toBe(5300);
  });

  test('a re-added peer starts from 0 instead of the old baseline', async () => {
    state.clients = [client(1, { quotaLimit: 100_000 })];

    state.counters.set('key1', 5000);
    await WireGuard.checkQuotas();

    // disable: config saved without the peer, counter gone
    state.clients[0]!.enabled = false;
    state.counters.delete('key1');
    await WireGuard.saveConfig();

    // enable and transfer more than the old baseline before the next check
    state.clients[0]!.enabled = true;
    await WireGuard.saveConfig();
    state.counters.set('key1', 7000);
    await WireGuard.checkQuotas();

    expect(state.clients[0]!.quotaUsed).toBe(12_000);
  });

  test('a new period unblocks the client and restores the peer', async () => {
    const anchor = new Date(Date.now() - 2 * 86_400_000);
    state.clients = [
      client(1, {
        quotaLimit: 1000,
        quotaPeriod: 'day',
        quotaUsed: 1500,
        quotaExceeded: true,
        quotaAnchor: anchor.toISOString(),
        quotaPeriodStart: anchor.toISOString(),
      }),
    ];

    await WireGuard.checkQuotas();

    expect(state.clients[0]!.quotaUsed).toBe(0);
    expect(state.clients[0]!.quotaExceeded).toBe(false);
    expect(lastConfig()).toContain('key1');
  });

  test('manual reset unblocks the client', async () => {
    state.clients = [
      client(1, { quotaLimit: 1000, quotaUsed: 1000, quotaExceeded: true }),
    ];

    await WireGuard.resetClientQuota(1);

    expect(state.clients[0]!.quotaUsed).toBe(0);
    expect(lastConfig()).toContain('key1');
  });
});
