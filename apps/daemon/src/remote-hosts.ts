/**
 * The names this daemon answers to besides loopback (e.g. its tailnet name), configured and never
 * inferred. The security policy reads the registry on every request, so a change applies at once:
 * each entry adds an allowed Host, its `https://` Origin and `wss://` in the page's CSP.
 */
import { normalizeRemoteHost, REMOTE_LIMITS } from "@ddl/core";

export interface RemoteHosts {
  list(): readonly string[];
  set(hosts: readonly string[]): void;
  onChange(listener: (hosts: readonly string[]) => void): () => void;
}

/** A remote host that isn't a DNS name with an optional port, or too many of them. */
export class InvalidRemoteHostsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRemoteHostsError";
  }
}

/**
 * Validates and normalizes a list of remote hosts with core's rules: lowercase `host[:port]`, no
 * IPs, schemes, paths or loopback names, at most `REMOTE_LIMITS.remoteHosts`. Repeats collapse.
 */
export function normalizeRemoteHosts(hosts: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const host of hosts) {
    const normalized = normalizeRemoteHost(host);
    if (normalized === null) {
      throw new InvalidRemoteHostsError(
        `"${host}" is not a remote host: use a DNS name with an optional :port (no scheme, path, IP address or loopback name)`,
      );
    }
    if (!out.includes(normalized)) out.push(normalized);
  }
  if (out.length > REMOTE_LIMITS.remoteHosts) {
    throw new InvalidRemoteHostsError(`At most ${REMOTE_LIMITS.remoteHosts} remote hosts`);
  }
  return Object.freeze(out);
}

/** The live registry. `set` validates the whole list first and changes nothing when it throws. */
export class RemoteHostRegistry implements RemoteHosts {
  #hosts: readonly string[];
  readonly #listeners = new Set<(hosts: readonly string[]) => void>();

  constructor(initial: readonly string[] = []) {
    this.#hosts = normalizeRemoteHosts(initial);
  }

  list(): readonly string[] {
    return this.#hosts;
  }

  set(hosts: readonly string[]): void {
    const next = normalizeRemoteHosts(hosts);
    if (next.length === this.#hosts.length && next.every((host, i) => host === this.#hosts[i])) {
      return;
    }
    this.#hosts = next;
    // A throwing listener must not keep the others (the policy's consumers) from hearing it.
    for (const listener of [...this.#listeners]) {
      try {
        listener(next);
      } catch {}
    }
  }

  onChange(listener: (hosts: readonly string[]) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export function createRemoteHosts(initial: readonly string[] = []): RemoteHostRegistry {
  return new RemoteHostRegistry(initial);
}
