/**
 * Validation shared by the daemon, the contract and the clients for remote access: the names a
 * daemon answers to besides loopback, the always-on machine's address, device names and pairing
 * codes. Pure string checks (plus the WHATWG `URL` parser): nothing here resolves or connects.
 */

export const REMOTE_LIMITS = {
  /** Device and machine names a user enters, after trimming. */
  deviceNameLength: 64,
  /** Names a daemon answers to besides loopback. */
  remoteHosts: 8,
  /** A DNS name, without the port. */
  hostnameLength: 253,
} as const;

/** Pairing codes: 8 characters without look-alikes (no 0, 1, I, L, O or U). */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIRING_CODE_LENGTH = 8;

const PAIRING_CODE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PORT = /^[1-9][0-9]{0,4}$/;
const CONTROL = /\p{Cc}/u;

/** `localhost`, `127.0.0.0/8` and `::1` (with or without brackets). */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255)
  );
}

/**
 * A DNS name another device reaches this daemon by (its tailnet name), lowercase. IP addresses and
 * loopback names are not remote hosts: the former are never configured, the latter always allowed.
 */
function isRemoteHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > REMOTE_LIMITS.hostnameLength) return false;
  const labels = hostname.split(".");
  if (!labels.every((label) => DNS_LABEL.test(label))) return false;
  // WHATWG URL parsers read a name whose last label is numeric as an IPv4 address.
  if (/^[0-9]+$/.test(labels.at(-1) ?? "")) return false;
  return hostname !== "localhost" && !hostname.endsWith(".localhost");
}

function isPort(port: string): boolean {
  return PORT.test(port) && Number(port) <= 65_535;
}

/**
 * `host[:port]` as this daemon's remote host (e.g. `vm-name.tailnet-name.ts.net`): trimmed and
 * lowercased, or null when it's not a DNS name with an optional port (IPs, schemes, paths,
 * loopback names and trailing dots are refused).
 */
export function normalizeRemoteHost(input: string): string | null {
  const value = input.trim().toLowerCase();
  const colon = value.indexOf(":");
  const hostname = colon === -1 ? value : value.slice(0, colon);
  const port = colon === -1 ? null : value.slice(colon + 1);
  if (!isRemoteHostname(hostname) || (port !== null && !isPort(port))) return null;
  return value;
}

/** True for a remote host in its normalized form (what the daemon reports). */
export function isRemoteHost(value: string): boolean {
  return normalizeRemoteHost(value) === value;
}

/**
 * The always-on machine's address as an origin, `https://<host>[:port]`, or null. It must be https
 * to a DNS name (plain http only to loopback, for tests) without path, query, fragment or
 * credentials. Case and a trailing `/` are normalized away.
 */
export function normalizeMachineUrl(input: string): string | null {
  const value = input.trim();
  // `URL` silently drops tabs and newlines, so refuse control characters first.
  if (!/^https?:\/\//i.test(value) || CONTROL.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  // `URL` drops an empty `?` or `#`, so check the input too.
  if (/[?#]/.test(value)) return null;
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === "http:" && !loopback) return null;
  if (!loopback && !isRemoteHostname(url.hostname)) return null;
  return url.origin;
}

/** True for a machine URL in its normalized form (what settings and responses carry). */
export function isMachineUrl(value: string): boolean {
  return normalizeMachineUrl(value) === value;
}

/**
 * A service URL a token may be sent to (the sync service): https, or plain http only to loopback,
 * without credentials. Unlike a machine URL it may carry a path.
 */
export function isSecureServiceUrl(input: string): boolean {
  if (CONTROL.test(input)) return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return (
    url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
  );
}

/** The default name of a machine: the first label of its host (`vm-name` for `vm-name.x.ts.net`). */
export function defaultMachineName(machineUrl: string): string {
  const { hostname } = new URL(machineUrl);
  return hostname.startsWith("[") ? hostname : (hostname.split(".")[0] ?? hostname);
}

/** A device or machine name a user entered: trimmed, 1–64 characters, no control characters. */
export function normalizeDeviceName(input: string): string | null {
  const name = input.trim();
  if (name.length === 0 || name.length > REMOTE_LIMITS.deviceNameLength || CONTROL.test(name)) {
    return null;
  }
  return name;
}

/**
 * A pairing code as typed (`xxxx-xxxx`, `XXXX XXXX`, `XXXXXXXX`) in its canonical form, 8
 * uppercase characters of `PAIRING_CODE_ALPHABET`, or null.
 */
export function normalizePairingCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  return PAIRING_CODE.test(code) ? code : null;
}

/** True for a pairing code in its canonical form (what the daemon issues). */
export function isPairingCode(value: string): boolean {
  return PAIRING_CODE.test(value);
}

/** How a pairing code is shown: `XXXX-XXXX`. */
export function formatPairingCode(code: string): string {
  const half = PAIRING_CODE_LENGTH / 2;
  return code.length === PAIRING_CODE_LENGTH ? `${code.slice(0, half)}-${code.slice(half)}` : code;
}
