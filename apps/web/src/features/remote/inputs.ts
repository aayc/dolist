import {
  isSecureServiceUrl,
  normalizeDeviceName,
  normalizeMachineUrl,
  normalizeRemoteHost,
  REMOTE_LIMITS,
  SYNC_ID_PATTERN,
} from "@ddl/core";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The always-on machine's address as typed: `https://` is assumed when no scheme is given. */
export function machineUrlFromInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  return normalizeMachineUrl(SCHEME.test(value) ? value : `https://${value}`);
}

export function machineUrlProblem(raw: string): string | null {
  if (!raw.trim()) return "Enter the machine's address.";
  return machineUrlFromInput(raw)
    ? null
    : "Use https:// and the machine's name, without a path: for example https://vm-name.tailnet-name.ts.net.";
}

/**
 * A name this daemon answers to, as typed: a pasted `https://host/` is taken as `host`; the rest
 * is `normalizeRemoteHost` (a DNS name with an optional port, never an IP address).
 */
export function remoteHostFromInput(raw: string): string | null {
  const value = raw
    .trim()
    .replace(/^https:\/\//i, "")
    .replace(/\/$/, "");
  return normalizeRemoteHost(value);
}

export function remoteHostProblem(raw: string, hosts: readonly string[]): string | null {
  if (!raw.trim()) return "Enter a name.";
  const host = remoteHostFromInput(raw);
  if (!host) {
    return "Use a DNS name like vm-name.tailnet-name.ts.net, optionally with :port: no IP address, http:// or path.";
  }
  if (hosts.includes(host)) return "It's already in the list.";
  if (hosts.length >= REMOTE_LIMITS.remoteHosts) {
    return `At most ${REMOTE_LIMITS.remoteHosts} names: remove one first.`;
  }
  return null;
}

export function syncUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Enter the sync service's address.";
  return isSecureServiceUrl(value)
    ? null
    : "Use https:// (plain http only on this computer), without a user name or password.";
}

export function syncVaultProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Enter the vault id.";
  return SYNC_ID_PATTERN.test(value) ? null : "Use 1–64 letters, digits, _ or -.";
}

/** The vault token is needed unless one is saved; it's one line without spaces. */
export function syncTokenProblem(raw: string, saved: boolean): string | null {
  const value = raw.trim();
  if (!value) return saved ? null : "Paste the vault token.";
  return /\s/.test(value) ? "The token is one line, without spaces." : null;
}

export function deviceNameProblem(raw: string): string | null {
  if (!raw.trim()) return "Enter a name.";
  return normalizeDeviceName(raw)
    ? null
    : `Use at most ${REMOTE_LIMITS.deviceNameLength} characters.`;
}
