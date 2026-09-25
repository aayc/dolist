import {
  type Logger,
  SYNC_API_VERSION,
  SYNC_DEVICE_HEADER,
  SYNC_ID_PATTERN,
  SYNC_LEASE_NAMES,
  SYNC_LEASE_PRIORITIES,
  SYNC_LIMITS,
  SYNC_ROUTES,
  type SyncChangesResponse,
  type SyncCreateFolderResponse,
  type SyncDeleteFolderResponse,
  type SyncFileListResponse,
  type SyncFileResponse,
  type SyncFolderListResponse,
  type SyncHealthResponse,
  type SyncLeaseConflictBody,
  type SyncLeaseName,
  type SyncLeaseResponse,
  type SyncLeaseStatusResponse,
  type SyncWriteResponse,
} from "@ddl/core";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getPath } from "hono/utils/url";
import { z } from "zod";
import { createErrorHandler, errorBody, SyncApiError } from "./errors";
import { filePathFromUrl, requirePath, requirePrefix } from "./paths";
import type { RateLimiter } from "./rate-limit";
import type { SyncStore } from "./store";
import type { StreamHub } from "./stream";
import { parseBearer } from "./tokens";

export interface SyncAppOptions {
  store: SyncStore;
  hub: StreamHub;
  limiter: RateLimiter;
  /** Largest file content accepted, in UTF-8 bytes. */
  maxFileBytes: number;
  logger: Logger;
  /** Called once per authenticated request, for the server's traffic summary. */
  onRequest?: (vault: string, status: number) => void;
}

type Env = { Variables: { vault: string } };

const RevSchema = z.string().min(1).max(256);
const DeviceIdSchema = z.string().regex(SYNC_ID_PATTERN, "must be 1-64 of A-Z a-z 0-9 _ -");

const WriteFileSchema = z.strictObject({
  content: z.string(),
  ifMatch: RevSchema.nullable().optional(),
});
const RenameSchema = z.strictObject({ from: z.string(), to: z.string() });
const FolderSchema = z.strictObject({ path: z.string() });
const LeaseRequestSchema = z.strictObject({
  device: DeviceIdSchema,
  deviceName: z
    .string()
    .trim()
    .min(1)
    .max(SYNC_LIMITS.deviceNameLength)
    .refine((name) => !/\p{Cc}/u.test(name), "must not contain control characters"),
  session: DeviceIdSchema,
  ttlMs: z.int().min(SYNC_LIMITS.leaseMinTtlMs).max(SYNC_LIMITS.leaseMaxTtlMs),
  priority: z.enum(SYNC_LEASE_PRIORITIES).optional(),
});
const SeqSchema = z
  .string()
  .regex(/^\d{1,15}$/, "must be a non-negative integer")
  .transform(Number);
const ChangesQuerySchema = z.object({
  since: SeqSchema.optional(),
  limit: SeqSchema.pipe(z.number().int().min(1).max(SYNC_LIMITS.changesPage)).optional(),
});

/** The sync service's HTTP API (the stream's WebSocket upgrade is handled by the server). */
export function createSyncApp(options: SyncAppOptions): Hono<Env> {
  const { store, hub, logger } = options;
  const app = new Hono<Env>({ getPath: routingPath });
  app.onError(createErrorHandler(logger));
  app.notFound((c) => c.json(errorBody("not_found", "Unknown route"), 404));

  app.get(SYNC_ROUTES.health, (c) => {
    const body: SyncHealthResponse = { ok: true, apiVersion: SYNC_API_VERSION };
    return c.json(body);
  });

  app.use("/v1/vaults/:vault/*", requestLogger(logger, options.onRequest));
  app.use("/v1/vaults/:vault/*", authenticate(store));
  app.use("/v1/vaults/:vault/*", rateLimit(options.limiter));
  app.use(
    "/v1/vaults/:vault/*",
    bodyLimit({
      // JSON escaping at most doubles realistic text (quotes, backslashes, newlines, tabs).
      maxSize: options.maxFileBytes * 2 + 64 * 1024,
      onError: (c) => c.json(errorBody("payload_too_large", "Request body too large"), 413),
    }),
  );

  // Registered before `/files/*`, which would also match the bare folder.
  app.get("/v1/vaults/:vault/files", (c) => {
    const body: SyncFileListResponse = store.listFiles(
      c.get("vault"),
      requirePrefix(c.req.query("prefix")),
    );
    return c.json(body);
  });

  app.get("/v1/vaults/:vault/files/*", (c) => {
    const path = filePathFromUrl(c.req.url);
    if (isFlag(c.req.query("meta"))) {
      const entry = store.stat(c.get("vault"), path);
      return entry ? c.json(entry) : notFound(c, path);
    }
    const file = store.read(c.get("vault"), path);
    if (!file) return notFound(c, path);
    const body: SyncFileResponse = file;
    return c.json(body);
  });

  app.put("/v1/vaults/:vault/files/*", async (c) => {
    const path = filePathFromUrl(c.req.url);
    const device = requireDevice(c);
    const { content, ifMatch } = await readJson(c, WriteFileSchema);
    if (Buffer.byteLength(content, "utf8") > options.maxFileBytes) {
      throw new SyncApiError(413, "payload_too_large", "File too large");
    }
    const vault = c.get("vault");
    const outcome = store.write(vault, path, content, ifMatch, device);
    if (outcome.change) hub.publish(vault, [outcome.change]);
    const body: SyncWriteResponse = {
      ...outcome.entry,
      created: outcome.created,
      seq: outcome.change?.seq ?? null,
    };
    return c.json(body, outcome.created ? 201 : 200);
  });

  app.delete("/v1/vaults/:vault/files/*", (c) => {
    const path = filePathFromUrl(c.req.url);
    const device = requireDevice(c);
    const rawIfMatch = c.req.query("ifMatch");
    const ifMatch = rawIfMatch === undefined ? undefined : parse(RevSchema, rawIfMatch, "ifMatch");
    const vault = c.get("vault");
    hub.publish(vault, [store.delete(vault, path, ifMatch, device)]);
    return c.body(null, 204);
  });

  app.post("/v1/vaults/:vault/rename", async (c) => {
    const device = requireDevice(c);
    const body = await readJson(c, RenameSchema);
    const vault = c.get("vault");
    const { entry, changes } = store.rename(
      vault,
      requirePath(body.from),
      requirePath(body.to),
      device,
    );
    hub.publish(vault, changes);
    const response: SyncWriteResponse = {
      ...entry,
      created: true,
      seq: changes[changes.length - 1]?.seq ?? null,
    };
    return c.json(response);
  });

  app.get("/v1/vaults/:vault/folders", (c) => {
    const body: SyncFolderListResponse = {
      folders: store.listFolders(c.get("vault"), requirePrefix(c.req.query("prefix"))),
    };
    return c.json(body);
  });

  app.post("/v1/vaults/:vault/folders", async (c) => {
    requireDevice(c);
    const path = requirePath((await readJson(c, FolderSchema)).path);
    const created = store.createFolder(c.get("vault"), path);
    const body: SyncCreateFolderResponse = { path };
    return c.json(body, created ? 201 : 200);
  });

  app.delete("/v1/vaults/:vault/folders", (c) => {
    const device = requireDevice(c);
    const path = requirePath(c.req.query("path") ?? "");
    const vault = c.get("vault");
    const { deleted, changes } = store.deleteFolder(vault, path, device);
    hub.publish(vault, changes);
    const body: SyncDeleteFolderResponse = { deleted };
    return c.json(body);
  });

  app.get("/v1/vaults/:vault/changes", (c) => {
    const query = parse(ChangesQuerySchema, c.req.query(), "query");
    const body: SyncChangesResponse = store.changesSince(
      c.get("vault"),
      query.since ?? 0,
      query.limit ?? SYNC_LIMITS.changesPage,
    );
    return c.json(body);
  });

  app.get("/v1/vaults/:vault/leases/:name", (c) => {
    const body: SyncLeaseStatusResponse = {
      holder: store.leaseHolder(c.get("vault"), leaseName(c)),
    };
    return c.json(body);
  });

  app.post("/v1/vaults/:vault/leases/:name", async (c) => {
    const name = leaseName(c);
    const device = requireDevice(c);
    const request = await readJson(c, LeaseRequestSchema);
    if (request.device !== device) {
      throw new SyncApiError(400, "invalid_request", `device must match ${SYNC_DEVICE_HEADER}`);
    }
    const outcome = store.acquireLease(c.get("vault"), name, request);
    if (!outcome.ok) return leaseHeld(c, outcome.holder);
    const body: SyncLeaseResponse = { lease: outcome.holder };
    return c.json(body);
  });

  app.delete("/v1/vaults/:vault/leases/:name", (c) => {
    const name = leaseName(c);
    requireDevice(c);
    const device = parse(DeviceIdSchema, c.req.query("device") ?? "", "device");
    const session = parse(DeviceIdSchema, c.req.query("session") ?? "", "session");
    const outcome = store.releaseLease(c.get("vault"), name, device, session);
    return outcome.ok ? c.body(null, 204) : leaseHeld(c, outcome.holder);
  });

  app.all("/v1/vaults/:vault/stream", (c) =>
    c.json(errorBody("upgrade_required", "Use a WebSocket upgrade"), 426),
  );
  return app;
}

function authenticate(store: SyncStore): MiddlewareHandler<Env> {
  return async (c, next) => {
    const vault = c.req.param("vault") ?? "";
    const token = parseBearer(c.req.header("authorization"));
    const valid =
      token !== undefined && SYNC_ID_PATTERN.test(vault) && store.authenticate(vault, token);
    if (!valid) {
      throw new SyncApiError(401, "unauthorized", "Missing or invalid token", {
        "WWW-Authenticate": 'Bearer realm="ddl-sync"',
      });
    }
    c.set("vault", vault);
    await next();
  };
}

function rateLimit(limiter: RateLimiter): MiddlewareHandler<Env> {
  return async (c, next) => {
    const waitMs = limiter.take(c.get("vault"));
    if (waitMs !== null) {
      throw new SyncApiError(429, "rate_limited", "Too many requests", {
        "Retry-After": String(Math.max(1, Math.ceil(waitMs / 1000))),
      });
    }
    await next();
  };
}

/** Logs every vault request at debug, without paths: the method, route pattern and status. */
function requestLogger(
  logger: Logger,
  onRequest: ((vault: string, status: number) => void) | undefined,
): MiddlewareHandler<Env> {
  return async (c, next) => {
    const started = performance.now();
    await next();
    const vault = c.get("vault");
    if (vault === undefined) return;
    onRequest?.(vault, c.res.status);
    logger.debug("request", {
      method: c.req.method,
      route: c.req.routePath,
      vault,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  };
}

function requireDevice(c: Context<Env>): string {
  const device = c.req.header(SYNC_DEVICE_HEADER);
  if (!device || !SYNC_ID_PATTERN.test(device)) {
    throw new SyncApiError(400, "invalid_request", `Missing or invalid ${SYNC_DEVICE_HEADER}`);
  }
  return device;
}

function leaseName(c: Context<Env>): SyncLeaseName {
  const name = c.req.param("name");
  const known = SYNC_LEASE_NAMES.find((candidate) => candidate === name);
  if (!known) throw new SyncApiError(404, "not_found", "Unknown lease");
  return known;
}

function leaseHeld(c: Context<Env>, holder: SyncLeaseConflictBody["holder"]): Response {
  const body: SyncLeaseConflictBody = {
    error: "lease_held",
    message: "Another device holds the lease",
    holder,
  };
  return c.json(body, 409);
}

function notFound(c: Context<Env>, path: string): Response {
  return c.json(errorBody("not_found", `No file at "${path}"`), 404);
}

async function readJson<S extends z.ZodType>(c: Context<Env>, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new SyncApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  return parse(schema, raw, "body");
}

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SyncApiError(
      400,
      "invalid_request",
      `Invalid ${what}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function isFlag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * Hono routes on the percent-decoded path, and its wildcard patterns don't match line terminators:
 * re-escaping them keeps such requests on their route (authenticated, then validated).
 */
function routingPath(request: Request): string {
  const path = getPath(request);
  let out = "";
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    out +=
      code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029
        ? encodeURIComponent(ch)
        : ch;
  }
  return out;
}
