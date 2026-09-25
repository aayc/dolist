import { PairingCodeRequestSchema, PairRequestSchema } from "@ddl/contract";
import {
  API_ROUTES,
  normalizePairingCode,
  type PairedDevicesResponse,
  type PairingCodeResponse,
  type PairResponse,
} from "@ddl/core";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppContext } from "../context";
import { ApiError, errorBody } from "../errors";
import { idParam, readJson } from "../http-utils";
import { MAX_PAIRED_DEVICES } from "../paired-devices";
import { PAIRING_LIMITS } from "../pairing";
import { principalOf, requestHostKind } from "../security";

/** `POST /api/pair` needs no credential, so it reads small bodies only. */
export const MAX_PAIR_BODY_BYTES = 1024;

/**
 * Pairing other devices with this daemon: issuing codes (any authenticated client), exchanging a
 * code for a device credential (no credential: the code is one), listing and revoking devices.
 * Codes and tokens are never logged.
 */
export function registerPairingRoutes(app: Hono, ctx: AppContext): void {
  const log = ctx.logger.child({ component: "pairing" });

  app.post(API_ROUTES.pairingCodes, async (c) => {
    const { name } = await readJson(c, PairingCodeRequestSchema);
    if (ctx.devices.isFull) {
      throw new ApiError(
        429,
        "rate_limited",
        `At most ${MAX_PAIRED_DEVICES} devices can be paired: revoke one first`,
      );
    }
    const issued = ctx.pairing.issue(name);
    if (!issued) {
      throw new ApiError(
        429,
        "rate_limited",
        `${PAIRING_LIMITS.maxOutstanding} pairing codes are already waiting: use one, or wait until they expire`,
      );
    }
    log.info("Issued a pairing code", { expiresAt: issued.expiresAt });
    const first = ctx.remoteHosts.list()[0];
    const body: PairingCodeResponse = {
      ...issued,
      url: first === undefined ? null : `https://${first.replace(/:443$/, "")}`,
    };
    return c.json(body, 201);
  });

  app.post(
    API_ROUTES.pair,
    rateLimit(ctx),
    bodyLimit({
      maxSize: MAX_PAIR_BODY_BYTES,
      onError: (c) =>
        c.json(
          errorBody(
            "payload_too_large",
            `Pairing requests are at most ${MAX_PAIR_BODY_BYTES} bytes`,
          ),
          413,
        ),
    }),
    async (c) => {
      const request = await readJson(c, PairRequestSchema);
      if (request.kind === "browser") {
        throw new ApiError(400, "invalid_request", "Browsers can't pair yet");
      }
      if (ctx.devices.isFull) {
        throw new ApiError(
          429,
          "rate_limited",
          `At most ${MAX_PAIRED_DEVICES} devices can be paired: revoke one first`,
        );
      }
      const redeemed = ctx.pairing.redeem(normalizePairingCode(request.code) ?? "");
      if (!redeemed) {
        log.info("Refused a pairing code");
        throw new ApiError(401, "pairing_rejected", "Wrong, expired or already used pairing code");
      }
      const { device, token } = await ctx.devices.add(redeemed.name ?? request.name, request.kind);
      log.info("Paired a device", { device: device.id, kind: device.kind, host: hostKind(c, ctx) });
      const body: PairResponse = { device, token };
      return c.json(body, 201);
    },
  );

  app.get(API_ROUTES.devices, (c) => {
    const principal = principalOf(c);
    const current = principal?.kind === "device" ? principal.device.id : undefined;
    const body: PairedDevicesResponse = {
      devices: ctx.devices
        .list()
        .map((device) => (device.id === current ? { ...device, current: true } : device)),
    };
    return c.json(body);
  });

  app.delete("/api/devices/:id", async (c) => {
    const id = idParam(c, "id");
    if (!(await ctx.devices.revoke(id))) throw new ApiError(404, "not_found", "Unknown device");
    log.info("Revoked a device", { device: id });
    return c.body(null, 204);
  });
}

/** The global attempt limit, counted before the body is even read. */
function rateLimit(ctx: AppContext): MiddlewareHandler {
  return async (c, next) => {
    const attempt = ctx.pairing.attempt();
    if (!attempt.allowed) {
      ctx.logger.warn("Pairing attempts are over the limit");
      c.header("Retry-After", String(Math.max(1, Math.ceil(attempt.retryAfterMs / 1000))));
      return c.json(
        errorBody("rate_limited", "Too many pairing attempts: try again in a minute"),
        429,
      );
    }
    await next();
  };
}

function hostKind(c: Context, ctx: AppContext) {
  const authority = new URL(c.req.url).host;
  return requestHostKind(ctx.policy, c.req.header("host") ?? authority, authority);
}
