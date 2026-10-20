import fs from 'node:fs/promises';

import { createDebug } from 'obug';

import { AsyncMutex } from '#server/utils/AsyncMutex';
import Database from '#server/utils/Database';
import { mergeClientStatuses } from '#server/utils/clientStatus';
import { OLD_ENV, WG_ENV } from '#server/utils/config';
import { firewall } from '#server/utils/firewall';
import { encodeQRCode } from '#server/utils/qr';
import { computeDelta, evaluateQuota } from '#server/utils/quota';
import type { ID } from '#server/utils/types';
import { wg } from '#server/utils/wgHelper';
import { setIntervalImmediately } from '#shared/utils/time';
import type { InterfaceType } from '#db/repositories/interface/types';
import type {
  ClientQueryType,
  ClientQuotaUpdateType,
  ClientType,
} from '#db/repositories/client/types';

const WG_DEBUG = createDebug('WireGuard');

const QUOTA_INTERVAL = 10 * 1000;

const generateRandomHeaderValue = () =>
  Math.floor(Math.random() * 2147483642) + 5;

/** Whether the client should be a peer in the WireGuard config */
const isPeerActive = (client: Pick<ClientType, 'enabled' | 'quotaExceeded'>) =>
  client.enabled && !client.quotaExceeded;

class WireGuard {
  /** Serializes config writes and quota accounting */
  #lock = new AsyncMutex();
  /** Last seen RX + TX counter per peer public key */
  #quotaBaselines = new Map<string, number>();
  #quotaTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Save and sync config
   */
  saveConfig() {
    return this.#lock.run(() => this.#saveConfigLocked());
  }

  async #saveConfigLocked() {
    const wgInterface = await Database.interfaces.get();
    // count usage before peers may be removed (their counters are lost)
    await this.#collectQuotaUsage(wgInterface);
    await this.#saveWireguardConfig(wgInterface);
    await this.#syncWireguardConfig(wgInterface);
    await this.#applyFirewallRules(wgInterface);
  }

  /**
   * Apply firewall rules based on current config
   */
  async #applyFirewallRules(wgInterface: InterfaceType) {
    const clients = await Database.clients.getAll();
    const userConfig = await Database.userConfigs.get();
    await firewall.rebuildRules(
      wgInterface,
      clients.map((client) => ({ ...client, enabled: isPeerActive(client) })),
      userConfig,
      !WG_ENV.DISABLE_IPV6
    );
  }

  /**
   * Add bytes transferred since the last reading to each quota client's usage
   *
   * Baselines are only kept in memory: the interface is recreated on startup,
   * so all counters start at 0 anyway.
   */
  async #collectQuotaUsage(wgInterface: InterfaceType) {
    const clients = await Database.clients.getAll();
    const quotaClients = new Map(
      clients
        .filter((client) => client.quotaLimit !== null)
        .map((client) => [client.publicKey, client.id])
    );

    if (quotaClients.size === 0) {
      this.#quotaBaselines.clear();
      return;
    }

    let dump;
    try {
      dump = await wg.dump(wgInterface.name);
    } catch (err) {
      // never let accounting block config changes
      WG_DEBUG('Reading transfer counters for quota failed.');
      console.error(err);
      return;
    }

    const seen = new Set<string>();
    const usage = [];

    for (const peer of dump) {
      const total = peer.transferRx + peer.transferTx;
      const delta = computeDelta(
        this.#quotaBaselines.get(peer.publicKey),
        total
      );
      this.#quotaBaselines.set(peer.publicKey, total);
      seen.add(peer.publicKey);

      const id = quotaClients.get(peer.publicKey);
      if (id !== undefined && delta > 0) {
        usage.push({ id, bytes: delta });
      }
    }

    // removed peers start from 0 when they are added again
    for (const publicKey of this.#quotaBaselines.keys()) {
      if (!seen.has(publicKey)) {
        this.#quotaBaselines.delete(publicKey);
      }
    }

    await Database.clients.addQuotaUsage(usage);
  }

  /**
   * Count only traffic from now on for this peer
   */
  async #primeQuotaBaseline(wgInterface: InterfaceType, publicKey: string) {
    const peer = (await wg.dump(wgInterface.name)).find(
      (peer) => peer.publicKey === publicKey
    );
    if (peer) {
      this.#quotaBaselines.set(publicKey, peer.transferRx + peer.transferTx);
    } else {
      this.#quotaBaselines.delete(publicKey);
    }
  }

  /**
   * Account usage, then block, unblock or start new periods as needed
   */
  checkQuotas() {
    return this.#lock.run(async () => {
      const wgInterface = await Database.interfaces.get();
      await this.#collectQuotaUsage(wgInterface);

      const clients = await Database.clients.getAll();
      const now = new Date();
      let needsSave = false;

      for (const client of clients) {
        const action = evaluateQuota(client, now);
        if (!action) continue;

        switch (action.type) {
          case 'reset':
            WG_DEBUG(`Quota period of client ${client.id} reset.`);
            await Database.clients.resetQuotaUsage(
              client.id,
              action.periodStart
            );
            needsSave ||= client.quotaExceeded;
            break;
          case 'block':
            WG_DEBUG(`Client ${client.id} exceeded its quota.`);
            await Database.clients.setQuotaExceeded(client.id, true);
            needsSave = true;
            break;
          case 'unblock':
            await Database.clients.setQuotaExceeded(client.id, false);
            needsSave = true;
            break;
        }
      }

      if (needsSave) {
        await this.#saveConfigLocked();
      }
    });
  }

  /**
   * Set or remove a client's quota and apply it
   */
  setClientQuota(clientId: ID, quota: ClientQuotaUpdateType) {
    return this.#lock.run(async () => {
      const wgInterface = await Database.interfaces.get();
      await this.#collectQuotaUsage(wgInterface);

      const client = await Database.clients.get(clientId);
      if (!client) {
        throw new Error('Client not found');
      }

      await Database.clients.setQuota(clientId, quota);
      await this.#primeQuotaBaseline(wgInterface, client.publicKey);
      await this.#saveConfigLocked();
    });
  }

  /**
   * Zero a client's usage in the current period and unblock it
   */
  resetClientQuota(clientId: ID) {
    return this.#lock.run(async () => {
      const wgInterface = await Database.interfaces.get();
      await this.#collectQuotaUsage(wgInterface);

      const client = await Database.clients.get(clientId);
      if (!client) {
        throw new Error('Client not found');
      }

      await Database.clients.resetQuotaUsage(clientId);
      await this.#primeQuotaBaseline(wgInterface, client.publicKey);
      await this.#saveConfigLocked();
    });
  }

  /**
   * Generates and saves WireGuard config from database
   *
   * Make sure to pass an updated InterfaceType object
   */
  async #saveWireguardConfig(wgInterface: InterfaceType) {
    const clients = await Database.clients.getAll();
    const hooks = await Database.hooks.get();

    const result = [];
    result.push(
      wg.generateServerInterface(wgInterface, hooks, {
        enableIpv6: !WG_ENV.DISABLE_IPV6,
      })
    );

    for (const client of clients) {
      if (!isPeerActive(client)) {
        continue;
      }
      result.push(
        wg.generateServerPeer(client, {
          enableIpv6: !WG_ENV.DISABLE_IPV6,
        })
      );
    }

    result.push('');

    WG_DEBUG('Saving Config...');
    await fs.writeFile(
      `/etc/wireguard/${wgInterface.name}.conf`,
      result.join('\n\n'),
      {
        mode: 0o600,
      }
    );
    WG_DEBUG('Config saved successfully.');
  }

  async #syncWireguardConfig(wgInterface: InterfaceType) {
    WG_DEBUG('Syncing Config...');
    await wg.sync(wgInterface.name);
    WG_DEBUG('Config synced successfully.');
  }

  async getClientsForUser(userId: ID, query: ClientQueryType) {
    const wgInterface = await Database.interfaces.get();

    const dbClients = await Database.clients.getAllForUser(userId, query);

    const clients = dbClients.map((client) => ({
      ...client,
      latestHandshakeAt: null as Date | null,
      endpoint: null as string | null,
      transferRx: null as number | null,
      transferTx: null as number | null,
    }));

    // Loop WireGuard status
    const dump = await wg.dump(wgInterface.name);
    return mergeClientStatuses(clients, dump);
  }

  async dumpByPublicKey(publicKey: string) {
    const wgInterface = await Database.interfaces.get();

    const dump = await wg.dump(wgInterface.name);
    const clientDump = dump.find(
      ({ publicKey: dumpPublicKey }) => dumpPublicKey === publicKey
    );

    return clientDump;
  }

  async getAllClients(query: ClientQueryType = {}) {
    const wgInterface = await Database.interfaces.get();

    const dbClients = await Database.clients.getAllPublic(query);

    const clients = dbClients.map((client) => ({
      ...client,
      latestHandshakeAt: null as Date | null,
      endpoint: null as string | null,
      transferRx: null as number | null,
      transferTx: null as number | null,
    }));

    // Loop WireGuard status
    const dump = await wg.dump(wgInterface.name);
    return mergeClientStatuses(clients, dump);
  }

  async getClientConfiguration({ clientId }: { clientId: ID }) {
    const wgInterface = await Database.interfaces.get();
    const userConfig = await Database.userConfigs.get();

    const client = await Database.clients.get(clientId);

    if (!client) {
      throw new Error('Client not found');
    }

    return wg.generateClientConfig(wgInterface, userConfig, client, {
      enableIpv6: !WG_ENV.DISABLE_IPV6,
    });
  }

  async getClientQRCodeSVG({ clientId }: { clientId: ID }) {
    const config = await this.getClientConfiguration({ clientId });
    return encodeQRCode(config);
  }

  cleanClientFilename(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9_=+.-]/g, '-')
      .replace(/(-{2,}|-$)/g, '-')
      .replace(/-$/, '')
      .substring(0, 32);
  }

  async Startup() {
    WG_DEBUG('Starting WireGuard...');
    // let as it has to refetch if keys change
    let wgInterface = await Database.interfaces.get();

    // default interface has no keys
    if (
      wgInterface.privateKey === '---default---' &&
      wgInterface.publicKey === '---default---'
    ) {
      WG_DEBUG('Generating new Wireguard Keys...');
      const privateKey = await wg.generatePrivateKey();
      const publicKey = await wg.getPublicKey(privateKey);

      await Database.interfaces.updateKeyPair(privateKey, publicKey);
      wgInterface = await Database.interfaces.get();
      WG_DEBUG('New Wireguard Keys generated successfully.');
    }

    if (wgInterface.h1 === '0') {
      WG_DEBUG('Generating random AmneziaWG obfuscation parameters...');
      const headers = new Set<number>();

      while (headers.size < 4) {
        headers.add(generateRandomHeaderValue());
      }
      const [h1, h2, h3, h4] = Array.from(headers);

      wgInterface.h1 = String(h1)!;
      wgInterface.h2 = String(h2)!;
      wgInterface.h3 = String(h3)!;
      wgInterface.h4 = String(h4)!;

      Database.interfaces.update(wgInterface);
    }

    WG_DEBUG(`Starting Wireguard Interface ${wgInterface.name}...`);
    await this.#saveWireguardConfig(wgInterface);
    await wg.down(wgInterface.name).catch(() => {});
    await wg.up(wgInterface.name).catch((err) => {
      if (
        err &&
        err.message &&
        err.message.includes(`Cannot find device "${wgInterface.name}"`)
      ) {
        throw new Error(
          `WireGuard exited with the error: Cannot find device "${wgInterface.name}"\nThis usually means that your host's kernel does not support WireGuard!`,
          { cause: err.message }
        );
      }

      throw err;
    });
    await this.#syncWireguardConfig(wgInterface);
    WG_DEBUG(`Wireguard Interface ${wgInterface.name} started successfully.`);

    // Check if firewall was enabled but iptables isn't available
    if (wgInterface.firewallEnabled) {
      const enableIpv6 = !WG_ENV.DISABLE_IPV6;
      const iptablesAvailable = await firewall.isAvailable(enableIpv6);
      if (!iptablesAvailable) {
        const requiredTools = enableIpv6 ? 'iptables/ip6tables' : 'iptables';
        console.warn(
          `WARNING: Per-Client Firewall is enabled but ${requiredTools} is not available. Disabling firewall feature. Please install ${requiredTools} to use this feature.`
        );
        await Database.interfaces.setFirewallEnabled(false);
        wgInterface.firewallEnabled = false; // Update local copy
      }
    }

    WG_DEBUG('Applying firewall rules...');
    await this.#applyFirewallRules(wgInterface);
    WG_DEBUG('Firewall rules applied successfully.');

    WG_DEBUG('Starting Cron Job...');
    await this.startCronJob();
    WG_DEBUG('Cron Job started successfully.');

    this.#startQuotaJob();
  }

  // TODO: handle as worker_thread
  async startCronJob() {
    setIntervalImmediately(() => {
      this.cronJob().catch((err) => {
        WG_DEBUG('Running Cron Job failed.');
        console.error(err);
      });
    }, 60 * 1000);
  }

  #startQuotaJob() {
    this.#stopQuotaJob();
    this.#quotaTimer = setInterval(() => {
      this.checkQuotas().catch((err) => {
        WG_DEBUG('Running Quota Job failed.');
        console.error(err);
      });
    }, QUOTA_INTERVAL);
  }

  #stopQuotaJob() {
    if (this.#quotaTimer) {
      clearInterval(this.#quotaTimer);
      this.#quotaTimer = null;
    }
  }

  // Shutdown wireguard
  async Shutdown() {
    this.#stopQuotaJob();
    await this.#lock.run(async () => {
      const wgInterface = await Database.interfaces.get();
      await this.#collectQuotaUsage(wgInterface).catch((err) => {
        WG_DEBUG('Saving quota usage failed.');
        console.error(err);
      });
      await wg.down(wgInterface.name).catch(() => {});
    });
  }

  Restart() {
    return this.#lock.run(async () => {
      const wgInterface = await Database.interfaces.get();
      await this.#collectQuotaUsage(wgInterface);
      await wg.restart(wgInterface.name);
      // all counters start at 0 again
      this.#quotaBaselines.clear();
    });
  }

  async cronJob() {
    const clients = await Database.clients.getAll();
    let needsSave = false;
    // Expires Feature
    for (const client of clients) {
      if (client.enabled !== true) continue;
      if (
        client.expiresAt !== null &&
        new Date() > new Date(client.expiresAt)
      ) {
        WG_DEBUG(`Client ${client.id} expired.`);
        await Database.clients.toggle(client.id, false);
        needsSave = true;
      }
    }
    // One Time Link Feature
    for (const client of clients) {
      if (
        client.oneTimeLink !== null &&
        new Date() > new Date(client.oneTimeLink.expiresAt)
      ) {
        WG_DEBUG(`OneTimeLink for Client ${client.id} expired.`);
        await Database.oneTimeLinks.delete(client.id);
        // otl does not need wireguard sync
      }
    }

    if (needsSave) {
      await this.saveConfig();
    }
  }
}

if (OLD_ENV.PASSWORD || OLD_ENV.PASSWORD_HASH) {
  throw new Error(
    `
You are using an invalid Configuration for wg-easy
Please follow the instructions on https://wg-easy.github.io/wg-easy/latest/advanced/migrate/from-14-to-15/ to migrate
`
  );
}

// TODO: make static or object

export default new WireGuard();
