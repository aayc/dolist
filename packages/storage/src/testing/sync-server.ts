/**
 * Test helpers: an in-process sync server (`@ddl/sync`, `:memory:` database, ephemeral loopback
 * port) with one vault, and RemoteStorageProviders for it. Tests only.
 */
import { SYNC_LIMITS } from "@ddl/core";
import { createSyncServer, type RunningSyncServer, type SyncServerOptions } from "@ddl/sync";
import { type RemoteStorageOptions, RemoteStorageProvider } from "../remote";

export interface TestSyncServer {
  server: RunningSyncServer;
  url: string;
  vault: string;
  token: string;
  /** A provider for this vault as device `deviceId`. Disposed by `close()`. */
  provider(deviceId: string, options?: Partial<RemoteStorageOptions>): RemoteStorageProvider;
  /** Makes `deviceId` hold the vault's agent lease (as long as allowed); returns the grant. */
  holdAgentLease(deviceId: string): { epoch: number; release(): void };
  close(): Promise<void>;
}

export async function startTestSyncServer(
  options: Partial<SyncServerOptions> = {},
): Promise<TestSyncServer> {
  const server = await createSyncServer({ db: ":memory:", port: 0, ...options });
  const { vault, token } = server.store.createVault("Test vault");
  const providers: RemoteStorageProvider[] = [];
  return {
    server,
    url: server.url,
    vault: vault.id,
    token,
    provider(deviceId, overrides = {}) {
      const provider = new RemoteStorageProvider({
        url: server.url,
        vault: vault.id,
        token,
        deviceId,
        deviceName: `Device ${deviceId}`,
        reconnectDelayMs: { initial: 50, max: 400 },
        ...overrides,
      });
      providers.push(provider);
      return provider;
    },
    holdAgentLease(deviceId) {
      const session = `s_test_${deviceId}`;
      const outcome = server.store.acquireLease(vault.id, "agent", {
        device: deviceId,
        deviceName: `Device ${deviceId}`,
        session,
        ttlMs: SYNC_LIMITS.leaseMaxTtlMs,
      });
      if (!outcome.ok) throw new Error(`${outcome.holder.device} holds the agent lease`);
      return {
        epoch: outcome.holder.epoch,
        release: () => {
          server.store.releaseLease(vault.id, "agent", deviceId, session);
        },
      };
    },
    async close() {
      await Promise.all(providers.map((provider) => provider.dispose()));
      await server.close();
    },
  };
}
