/**
 * The names this daemon answers to besides loopback (its tailnet name, say), changeable while it
 * runs. `PATCH /api/device` calls `set`; the security policy reads `list` and follows `onChange`.
 */
export interface RemoteHosts {
  list(): readonly string[];
  set(hosts: readonly string[]): void;
  onChange(listener: (hosts: readonly string[]) => void): () => void;
}

/** A registry holding the list in memory. */
export function createRemoteHosts(initial: readonly string[] = []): RemoteHosts {
  let hosts: readonly string[] = [...initial];
  const listeners = new Set<(hosts: readonly string[]) => void>();
  return {
    list: () => hosts,
    set(next) {
      hosts = [...next];
      for (const listener of [...listeners]) listener(hosts);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
