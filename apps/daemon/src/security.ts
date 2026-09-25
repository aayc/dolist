import { API_ROUTES, isLoopbackHostname, type PairedDevice } from "@ddl/core";
import type { Context, MiddlewareHandler } from "hono";
import { errorBody } from "./errors";
import { BEARER_DEVICE_KINDS, COOKIE_DEVICE_KINDS, type PairedDeviceStore } from "./paired-devices";
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

/** Who an authenticated request acts for: this machine (the master token) or a paired device. */
export type Principal = { kind: "master" } | { kind: "device"; device: PairedDevice };

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
  /** A bearer token: the master token, or the token of a paired app or daemon. */
  authenticateBearer(candidate: string | null | undefined): Principal | null;
  /**
   * A paired browser's device cookie: only on a remote Host, and only from the page itself, i.e.
   * with an Origin equal to the Host's own `https://` origin or, for the requests browsers send
   * without one (same-origin GETs), with `Sec-Fetch-Site: same-origin`.
   */
  authenticateCookie(request: CookieRequest): Principal | null;
  /** Whether `origin` is the request's own (the Host's `https://` origin on a remote Host). */
  isOwnOrigin(host: string | null | undefined, origin: string | null | undefined): boolean;
}

export interface CookieRequest {
  kind: HostKind;
  host: string | null | undefined;
  cookie: string | null | undefined;
  origin: string | null | undefined;
  fetchSite: string | null | undefined;
}

/**
 * The paired browser's credential. The `__Host-` prefix makes browsers insist on `Secure`,
 * `Path=/` and no `Domain`, so no other host (another tailnet name included) can set or overwrite
 * it. Script on the page never sees it (`HttpOnly`).
 */
export const DEVICE_COOKIE = "__Host-ddl-device";
/** Browsers cap cookie lifetimes at 400 days. */
const DEVICE_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const COOKIE_ATTRIBUTES = "HttpOnly; Secure; SameSite=Strict; Path=/";

export function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}`;
}

export const CLEARED_DEVICE_COOKIE = `${DEVICE_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;

/** The device cookie's value, when the header carries exactly one. */
export function deviceCookieValue(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const values: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === DEVICE_COOKIE) {
      values.push(part.slice(eq + 1).trim());
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

export interface SecurityPolicyOptions {
  /** The port the daemon actually listens on. */
  port: number;
  token: string;
  extraOrigins?: readonly string[];
  /** Read on every request, so changes apply at once. Default: none. */
  remoteHosts?: Pick<RemoteHosts, "list">;
  /** Paired devices' credentials. Default: none (the master token only). */
  devices?: Pick<PairedDeviceStore, "authenticate">;
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
  const remoteOrigin = (host: string | null | undefined): string | null => {
    if (hostKind(host) !== "remote") return null;
    const origin = `https://${withoutDefaultPort(host!.trim().toLowerCase())}`;
    return isOriginAllowed(origin) ? origin : null;
  };
  const isOwnOrigin = (host: string | null | undefined, origin: string | null | undefined) => {
    const own = remoteOrigin(host);
    return own !== null && typeof origin === "string" && normalizeOrigin(origin) === own;
  };
  const verifyMaster = createTokenVerifier(options.token);
  const devices = options.devices;
  return {
    port: options.port,
    allowedHosts: hosts,
    allowedOrigins: origins,
    hostKind,
    isHostAllowed: (host) => hostKind(host) !== null,
    isOriginAllowed,
    remoteOrigin,
    remoteSocketSources: () => [...remote().sockets],
    authenticateBearer: (candidate) => {
      if (verifyMaster(candidate)) return { kind: "master" };
      const device = devices?.authenticate(candidate, BEARER_DEVICE_KINDS);
      return device ? { kind: "device", device } : null;
    },
    authenticateCookie: ({ kind, host, cookie, origin, fetchSite }) => {
      if (kind !== "remote" || remoteOrigin(host) === null) return null;
      const fromPage =
        origin === undefined || origin === null
          ? fetchSite === "same-origin"
          : isOwnOrigin(host, origin);
      if (!fromPage) return null;
      const device = devices?.authenticate(deviceCookieValue(cookie), COOKIE_DEVICE_KINDS);
      return device ? { kind: "device", device } : null;
    },
    isOwnOrigin,
  };
}

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal;
  }
}

/** Who the request acts for; set by `requestGuard` on every authenticated `/api/*` request. */
export function principalOf(c: Context): Principal | undefined {
  return c.get("principal");
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
 * allowlist and authentication on `/api/*`: a bearer token (master or paired app/daemon), or on a
 * remote Host a paired browser's cookie sent by its own page. Requests without an Origin (curl,
 * native clients) are accepted with a valid bearer token; a present-but-unknown Origin, including
 * `null`, never is. `POST /api/pair` is the one route without a credential: its pairing code is
 * checked (and rate-limited) by the route itself.
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
      if (c.req.method === "POST" && c.req.path === API_ROUTES.pair) return next();
      const authorization = c.req.header("authorization");
      // A request that names a bearer token is judged by it alone, never by a cookie as well.
      const principal =
        authorization !== undefined
          ? policy.authenticateBearer(parseBearer(authorization))
          : policy.authenticateCookie({
              kind,
              host,
              cookie: c.req.header("cookie"),
              origin,
              fetchSite: c.req.header("sec-fetch-site"),
            });
      if (!principal) {
        c.header("WWW-Authenticate", "Bearer");
        return c.json(errorBody("unauthorized", "Missing or invalid bearer token"), 401);
      }
      c.set("principal", principal);
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
