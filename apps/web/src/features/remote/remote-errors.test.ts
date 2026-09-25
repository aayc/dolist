import type { ApiErrorCode } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { HttpError, NetworkError } from "../../api/errors";
import { cleanMessage, type RemoteAction, remoteErrorMessage } from "./remote-errors";

function daemonError(status: number, error: ApiErrorCode, message?: string): HttpError {
  return new HttpError(status, message ?? error, { error, ...(message ? { message } : {}) });
}

describe("remote error messages", () => {
  const table: Array<[string, HttpError | Error, RemoteAction, string]> = [
    [
      "a rejected pairing code",
      daemonError(401, "pairing_rejected", "Wrong, expired or already used pairing code"),
      "pair",
      "That code didn't work: it's wrong, expired or already used. Get a new one and try again.",
    ],
    [
      "a code the machine rejected",
      daemonError(401, "pairing_rejected", "The machine rejected the pairing code"),
      "machinePair",
      "The always-on machine didn't accept that code: it's wrong, expired or already used. Get a new one on the machine.",
    ],
    [
      "a placement set by an environment variable",
      daemonError(409, "locked_by_env", "DDL_AGENT_PLACEMENT sets where the agent runs"),
      "placement",
      "An environment variable (DDL_AGENT_PLACEMENT) sets where the agent runs on this device, so it can't be changed here.",
    ],
    [
      "remote hosts set by an environment variable",
      daemonError(409, "locked_by_env"),
      "remoteHosts",
      "An environment variable (DDL_REMOTE_HOSTS) sets the names this daemon answers to, so they can't be changed here.",
    ],
    [
      "sync set by environment variables",
      daemonError(409, "locked_by_env"),
      "syncOff",
      "Environment variables (DDL_SYNC_URL, DDL_SYNC_VAULT, DDL_SYNC_TOKEN) set this device's sync, so it can't be turned off here.",
    ],
    [
      "too many pairing attempts, with Retry-After",
      new HttpError(
        429,
        "Too many pairing attempts: try again in a minute",
        { error: "rate_limited", message: "Too many pairing attempts: try again in a minute" },
        40,
      ),
      "pair",
      "Too many pairing attempts. Try again in 40 seconds.",
    ],
    [
      "too many pairing attempts for a few minutes",
      new HttpError(429, "x", { error: "rate_limited" }, 125),
      "pair",
      "Too many pairing attempts. Try again in 3 minutes.",
    ],
    [
      "no more devices (no Retry-After: the daemon says why)",
      daemonError(429, "rate_limited", "At most 20 devices can be paired: revoke one first"),
      "pair",
      "At most 20 devices can be paired: revoke one first.",
    ],
    [
      "the machine refusing more attempts",
      daemonError(429, "rate_limited", "vm-1 refused more pairing attempts for now"),
      "machinePair",
      "The always-on machine refused more attempts for now. Wait a minute, then try again.",
    ],
    [
      "too many codes waiting",
      daemonError(429, "rate_limited"),
      "pairingCode",
      "Too many pairing codes are waiting. Use one, or wait until they expire.",
    ],
    [
      "the device list is full (the daemon says why)",
      daemonError(429, "rate_limited", "At most 20 devices can be paired: revoke one first"),
      "revoke",
      "At most 20 devices can be paired: revoke one first.",
    ],
    [
      "an unreachable machine",
      daemonError(502, "machine_unreachable", "vm-1.tailnet-name.ts.net didn't answer in 5 s"),
      "machinePair",
      "The always-on machine didn't answer. Check that it's running and that this device is on your private network (for example Tailscale). vm-1.tailnet-name.ts.net didn't answer in 5 s.",
    ],
    [
      "an agent that can't act here",
      daemonError(503, "agent_unavailable", "The agent is running on Work laptop."),
      "placement",
      "The agent is running on Work laptop.",
    ],
    [
      "a validation failure, worded by zod",
      daemonError(
        400,
        "invalid_request",
        "✖ must be a DNS name with an optional :port (no scheme, path, IP address or loopback name)\n  → at remoteHosts[0]",
      ),
      "remoteHosts",
      "Must be a DNS name with an optional :port (no scheme, path, IP address or loopback name).",
    ],
    [
      "a missing token",
      daemonError(400, "invalid_request", "No vault token is saved yet: include `token`"),
      "sync",
      "No vault token is saved yet: include `token`.",
    ],
    [
      "a device already revoked",
      daemonError(404, "not_found", "Unknown device"),
      "revoke",
      "That device isn't paired anymore.",
    ],
    [
      "a daemon without the route",
      daemonError(404, "not_found", "Not found"),
      "load",
      "This version of Daily Do List can't do that yet. Update it, then try again.",
    ],
    [
      "a revoked device",
      daemonError(401, "unauthorized", "Missing or invalid bearer token"),
      "rename",
      "This device isn't allowed in anymore. Pair it again.",
    ],
    [
      "a proxy forwarding with a loopback Host",
      daemonError(
        403,
        "forbidden_host",
        "A proxy forwarded this request with a loopback Host: make it keep the original Host and add that name to remote.hosts",
      ),
      "pair",
      "Daily Do List refused this page's address. A proxy forwarded this request with a loopback Host: make it keep the original Host and add that name to remote.hosts.",
    ],
    [
      "codes waiting (the daemon says how many)",
      daemonError(
        429,
        "rate_limited",
        "3 pairing codes are already waiting: use one, or wait until they expire",
      ),
      "pairingCode",
      "3 pairing codes are already waiting: use one, or wait until they expire.",
    ],
    [
      "a refused page address",
      daemonError(403, "forbidden_origin", "Origin not allowed"),
      "pair",
      "Daily Do List refused this page's address. Open it at one of its remote hosts.",
    ],
    [
      "a daemon failure",
      daemonError(500, "internal_error", "boom"),
      "sync",
      "Something went wrong in Daily Do List: Boom.",
    ],
    [
      "no daemon",
      new NetworkError("fetch failed"),
      "pair",
      "Couldn't reach Daily Do List. Check that it's running, then try again.",
    ],
  ];

  it.each(table)("%s", (_label, error, action, expected) => {
    expect(remoteErrorMessage(error, action)).toBe(expected);
  });

  it("maps every error code the daemon can answer these routes with", () => {
    const codes: ApiErrorCode[] = [
      "invalid_json",
      "invalid_request",
      "unauthorized",
      "pairing_rejected",
      "forbidden_host",
      "forbidden_origin",
      "not_found",
      "locked_by_env",
      "payload_too_large",
      "rate_limited",
      "internal_error",
      "machine_unreachable",
      "agent_unavailable",
    ];
    for (const code of codes) {
      const message = remoteErrorMessage(daemonError(400, code), "sync");
      expect(message, code).toMatch(/[.!?…]$/);
      expect(message, code).not.toContain(code);
    }
  });

  it("turns daemon messages into sentences", () => {
    expect(cleanMessage("unknown device")).toBe("Unknown device.");
    expect(cleanMessage("Done!")).toBe("Done!");
    expect(cleanMessage("✖ a\n  → at x\n✖ b\n  → at y")).toBe("A; b.");
    expect(cleanMessage("  ")).toBe("");
  });
});
