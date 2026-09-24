import type { MiddlewareHandler } from "hono";
import { errorBody } from "./errors";
import { createTokenVerifier, parseBearer } from "./token";

/** Vite dev server port. Its proxy forwards `/api` and `/ws` with the browser's Host/Origin. */
export const DEV_SERVER_PORT = 5173;

/**
 * DNS-rebinding and CSRF defense shared by HTTP and the WebSocket upgrade: only loopback Host
 * headers, only known Origins, and a bearer token compared in constant time.
 */
export interface SecurityPolicy {
  readonly port: number;
  readonly allowedHosts: ReadonlySet<string>;
  readonly allowedOrigins: ReadonlySet<string>;
  isHostAllowed(host: string | null | undefined): boolean;
  isOriginAllowed(origin: string | null | undefined): boolean;
  verifyToken(candidate: string | null | undefined): boolean;
}

export interface SecurityPolicyOptions {
  /** The port the daemon actually listens on. */
  port: number;
  token: string;
  extraOrigins?: readonly string[];
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
  const verifyToken = createTokenVerifier(options.token);
  return {
    port: options.port,
    allowedHosts: hosts,
    allowedOrigins: origins,
    isHostAllowed: (host) => typeof host === "string" && hosts.has(host.trim().toLowerCase()),
    isOriginAllowed: (origin) => typeof origin === "string" && origins.has(normalizeOrigin(origin)),
    verifyToken,
  };
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
    if (!policy.isHostAllowed(host) || !policy.isHostAllowed(authority)) {
      return c.json(errorBody("forbidden_host", "Unexpected Host header"), 403);
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
