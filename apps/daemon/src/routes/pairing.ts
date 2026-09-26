import { PairingCodeRequestSchema, PairRequestSchema } from "@ddl/contract";
import {
  API_PATHS,
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
import { CLEARED_DEVICE_COOKIE, deviceCookie, principalOf, requestHostKind } from "../security";

/** `POST /api/pair` needs no credential, so it reads small bodies only. */
export const MAX_PAIR_BODY_BYTES = 1024;

/**
 * Pairing other devices with this daemon: issuing codes (any authenticated client), exchanging a
 * code for a device credential (no credential: the code is one), listing and revoking devices.
 * Codes and tokens are never logged.
 */
export function registerPairingRoutes(app: Hono, ctx: AppContext): void {
  const log = ctx.logger.child({ component: "pairing" });

  app.post(API_PATHS.pairingCodes, async (c) => {
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
    API_PATHS.pair,
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
      const kind = hostKind(c, ctx);
      const browser = request.kind === "browser";
      // The cookie only works on a remote Host, from its own https page; locally the page has the token.
      if (
        browser &&
        (kind !== "remote" || !ctx.policy.isOwnOrigin(hostOf(c), c.req.header("origin")))
      ) {
        throw new ApiError(
          400,
          "invalid_request",
          "A browser pairs from the daemon's page on one of its remote hosts (https://…); on this machine the page needs no pairing",
        );
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
      log.info("Paired a device", { device: device.id, kind: device.kind, host: kind });
      if (browser) {
        c.header("Set-Cookie", deviceCookie(token));
        const body: PairResponse = { device };
        return c.json(body, 201);
      }
      const body: PairResponse = { device, token };
      return c.json(body, 201);
    },
  );

  app.get(API_PATHS.devices, (c) => {
    const principal = principalOf(c);
    const current = principal?.kind === "device" ? principal.device.id : undefined;
    const body: PairedDevicesResponse = {
      devices: ctx.devices
        .list()
        .map((device) => (device.id === current ? { ...device, current: true } : device)),
    };
    return c.json(body);
  });

  app.delete(API_PATHS.pairedDevice, async (c) => {
    const id = idParam(c, "id");
    if (!(await ctx.devices.revoke(id))) throw new ApiError(404, "not_found", "Unknown device");
    log.info("Revoked a device", { device: id });
    const principal = principalOf(c);
    if (principal?.kind === "device" && principal.device.id === id) {
      if (principal.device.kind === "browser") c.header("Set-Cookie", CLEARED_DEVICE_COOKIE);
    }
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

function hostOf(c: Context): string {
  return c.req.header("host") ?? new URL(c.req.url).host;
}

function hostKind(c: Context, ctx: AppContext) {
  return requestHostKind(ctx.policy, hostOf(c), new URL(c.req.url).host);
}
