import { isLoopbackHostname } from "@ddl/core";
import type { MiddlewareHandler } from "hono";
import { errorBody } from "./errors";
import type { RemoteHosts } from "./remote-hosts";
import { createTokenVerifier, parseBearer } from "./token";

/** Vite dev server port. Its proxy forwards `/api` and `/ws` with the browser's Host/Origin. */
export const DEV_SERVER_PORT = 5173;

/**
 * How a request's Host is served. `loopback`: this machine (the page embeds the master token).
 * `remote`: a configured remote host reached through a private-network proxy (device credentials
 * only, never the master token in a page).
 */
export type HostKind = "loopback" | "remote";

/**
 * DNS-rebinding and CSRF defense shared by HTTP and the WebSocket upgrade: only loopback Host
 * headers and configured remote hosts, only known Origins, and a bearer token compared in constant
 * time.
 */
export interface SecurityPolicy {
  readonly port: number;
  /** Loopback names on the daemon and dev server ports, plus hosts of `allowedOrigins`. */
  readonly allowedHosts: ReadonlySet<string>;
  /** Origins of `allowedHosts` and `allowedOrigins`. Remote hosts add theirs live. */
  readonly allowedOrigins: ReadonlySet<string>;
  /** null: the Host is refused. */
  hostKind(host: string | null | undefined): HostKind | null;
  isHostAllowed(host: string | null | undefined): boolean;
  isOriginAllowed(origin: string | null | undefined): boolean;
  /** `https://<host>` for a remote Host when it is an allowed Origin: the request's own origin. */
  remoteOrigin(host: string | null | undefined): string | null;
  /** `wss://` sources of the remote hosts, for the page's `connect-src`. */
  remoteSocketSources(): string[];
  verifyToken(candidate: string | null | undefined): boolean;
}

export interface SecurityPolicyOptions {
  /** The port the daemon actually listens on. */
  port: number;
  token: string;
  extraOrigins?: readonly string[];
  /** Read on every request, so changes apply at once. Default: none. */
  remoteHosts?: Pick<RemoteHosts, "list">;
}

interface RemoteView {
  source: readonly string[];
  hosts: Set<string>;
  /** `https://…` origins, without a default `:443`. */
  origins: Set<string>;
  sockets: string[];
}

export function createSecurityPolicy(options: SecurityPolicyOptions): SecurityPolicy {
  const hosts = new Set<string>();
  const origins = new Set<string>();
  for (const port of [options.port, DEV_SERVER_PORT]) {
    for (const hostname of ["127.0.0.1", "localhost"]) {
      hosts.add(`${hostname}:${port}`);
      origins.add(`http://${hostname}:${port}`);
      if (port === 80) {
        hosts.add(hostname);
        origins.add(`http://${hostname}`);
      }
    }
  }
  for (const origin of options.extraOrigins ?? []) {
    const normalized = normalizeOrigin(origin);
    origins.add(normalized);
    // A proxied dev server on another port forwards its own Host (unless it rewrites it).
    const host = httpHost(normalized);
    if (host) hosts.add(host);
  }

  const registry = options.remoteHosts;
  let view: RemoteView = remoteView([]);
  const remote = (): RemoteView => {
    const list = registry?.list() ?? [];
    // The registry hands out the same frozen list until it changes.
    if (list !== view.source) view = remoteView(list);
    return view;
  };

  const hostKind = (host: string | null | undefined): HostKind | null => {
    if (typeof host !== "string") return null;
    const normalized = host.trim().toLowerCase();
    if (hosts.has(normalized)) return isLoopbackHost(normalized) ? "loopback" : "remote";
    return remote().hosts.has(normalized) ? "remote" : null;
  };
  const isOriginAllowed = (origin: string | null | undefined): boolean => {
    if (typeof origin !== "string") return false;
    const normalized = normalizeOrigin(origin);
    return origins.has(normalized) || remote().origins.has(normalized);
  };
  const verifyToken = createTokenVerifier(options.token);
  return {
    port: options.port,
    allowedHosts: hosts,
    allowedOrigins: origins,
    hostKind,
    isHostAllowed: (host) => hostKind(host) !== null,
    isOriginAllowed,
    remoteOrigin: (host) => {
      if (hostKind(host) !== "remote") return null;
      const origin = `https://${withoutDefaultPort(host!.trim().toLowerCase())}`;
      return isOriginAllowed(origin) ? origin : null;
    },
    remoteSocketSources: () => [...remote().sockets],
    verifyToken,
  };
}

function remoteView(source: readonly string[]): RemoteView {
  const hosts = new Set<string>();
  const origins = new Set<string>();
  const sockets: string[] = [];
  for (const entry of source) {
    const bare = withoutDefaultPort(entry);
    // Browsers leave the default port out of Host and Origin.
    hosts.add(entry).add(bare);
    origins.add(`https://${bare}`);
    sockets.push(`wss://${bare}`);
  }
  return { source, hosts, origins, sockets };
}

function withoutDefaultPort(host: string): string {
  return host.endsWith(":443") ? host.slice(0, -4) : host;
}

function isLoopbackHost(host: string): boolean {
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Headers a reverse proxy adds. A proxy that forwards remote traffic with a loopback Host would
 * make it look local (and hand out the page's master token), so such requests are refused: the
 * proxy must keep the original Host, which is then configured as a remote host.
 */
const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"] as const;

export function forwardedByProxy(header: (name: string) => string | null | undefined): boolean {
  return PROXY_HEADERS.some((name) => header(name) != null);
}

export const PROXIED_LOOPBACK_MESSAGE =
  "A proxy forwarded this request with a loopback Host: make it keep the original Host and add that name to remote.hosts";

/**
 * The kind of a request whose Host header and request-target authority may differ (an
 * absolute-form request line names its own): refused if either is, remote if either is.
 */
export function requestHostKind(
  policy: SecurityPolicy,
  host: string | null | undefined,
  authority: string | null | undefined,
): HostKind | null {
  const kinds = [policy.hostKind(host), policy.hostKind(authority)];
  if (kinds.includes(null)) return null;
  return kinds.includes("remote") ? "remote" : "loopback";
}

export function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/**
 * Host allowlist on every request (the web app's index.html carries the token), then Origin
 * allowlist and bearer auth on `/api/*`. Requests without an Origin (curl, native clients) are
 * accepted when the token is valid; a present-but-unknown Origin, including `null`, never is.
 */
export function requestGuard(policy: SecurityPolicy): MiddlewareHandler {
  return async (c, next) => {
    // An absolute-form request line (`GET http://evil.example/ HTTP/1.1`) names its own authority,
    // which takes precedence over the Host header, so both must be allowlisted.
    const authority = new URL(c.req.url).host;
    const host = c.req.header("host") ?? authority;
    const kind = requestHostKind(policy, host, authority);
    if (kind === null) {
      return c.json(errorBody("forbidden_host", "Unexpected Host header"), 403);
    }
    if (kind === "loopback" && forwardedByProxy((name) => c.req.header(name))) {
      return c.json(errorBody("forbidden_host", PROXIED_LOOPBACK_MESSAGE), 403);
    }
    if (isApiPath(c.req.path)) {
      const origin = c.req.header("origin");
      if (origin !== undefined && !policy.isOriginAllowed(origin)) {
        return c.json(errorBody("forbidden_origin", "Origin not allowed"), 403);
      }
      if (!policy.verifyToken(parseBearer(c.req.header("authorization")))) {
        c.header("WWW-Authenticate", "Bearer");
        return c.json(errorBody("unauthorized", "Missing or invalid bearer token"), 401);
      }
    }
    await next();
  };
}

/** Headers for every response. HTML documents add their CSP in the web routes. */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    if (isApiPath(c.req.path) && !headers.has("Cache-Control")) {
      headers.set("Cache-Control", "no-store");
    }
  };
}

function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, "");
}

function httpHost(origin: string): string | undefined {
  if (!/^https?:\/\//.test(origin)) return undefined;
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}
