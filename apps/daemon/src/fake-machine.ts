/**
 * Tests only: an always-on machine's daemon as far as this device's machine link sees it, on an
 * ephemeral loopback port. It answers the contract's shapes for `/api/pair` (kind `daemon`),
 * `/api/health`, `/api/agent/status` and `/api/devices/:id`, issues random tokens and records
 * what it was asked (never logging anything).
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AgentStatusResponse,
  normalizePairingCode,
  type PairedDevice,
  type PairResponse,
} from "@ddl/core";

export interface FakeMachineRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

export interface FakeMachine {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** The pairing code it accepts (once). */
  code: string;
  readonly requests: FakeMachineRequest[];
  readonly devices: PairedDevice[];
  readonly revoked: string[];
  /** Answers `/api/pair` with this instead (then goes back to normal). */
  pairAnswer: { status: number; body?: unknown } | undefined;
  /** Stops answering at all (requests hang until the client gives up). */
  hang: boolean;
  /** Revokes every token it issued. */
  revokeAll(): void;
  close(): Promise<void>;
}

export async function startFakeMachine(): Promise<FakeMachine> {
  const tokens = new Map<string, string>();
  let code: string | null = "ABCD2345";
  const machine: FakeMachine = {
    url: "",
    code: "ABCD-2345",
    requests: [],
    devices: [],
    revoked: [],
    pairAnswer: undefined,
    hang: false,
    revokeAll: () => tokens.clear(),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const deviceOf = (req: IncomingMessage): string | undefined => {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    return token ? tokens.get(token) : undefined;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body: unknown = text ? JSON.parse(text) : undefined;
    const path = req.url ?? "/";
    machine.requests.push({
      method: req.method ?? "GET",
      path,
      authorization: req.headers.authorization,
      body,
    });
    if (machine.hang) return;
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, payload === undefined ? {} : { "content-type": "application/json" });
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    };

    if (req.method === "POST" && path === "/api/pair") {
      if (machine.pairAnswer) {
        const answer = machine.pairAnswer;
        machine.pairAnswer = undefined;
        send(answer.status, answer.body);
        return;
      }
      const request = body as { code?: string; name?: string; kind?: string };
      if (!code || normalizePairingCode(request.code ?? "") !== code) {
        send(401, { error: "pairing_rejected", message: "Wrong, expired or already used code" });
        return;
      }
      code = null;
      const device: PairedDevice = {
        id: `pd_${randomBytes(6).toString("hex")}`,
        name: request.name ?? "",
        kind: request.kind === "daemon" ? "daemon" : "app",
        createdAt: Date.now(),
        lastSeenAt: null,
      };
      const token = randomBytes(32).toString("base64url");
      tokens.set(token, device.id);
      machine.devices.push(device);
      const answer: PairResponse = { device, token };
      send(201, answer);
      return;
    }
    const device = deviceOf(req);
    if (!device) {
      send(401, { error: "unauthorized", message: "Missing or invalid bearer token" });
      return;
    }
    if (req.method === "GET" && path === "/api/health") {
      send(200, {
        ok: true,
        version: "0.2.0",
        apiVersion: 1,
        vaultName: "Vault",
        agentMode: "live",
      });
      return;
    }
    if (req.method === "GET" && path === "/api/agent/status") {
      const status: AgentStatusResponse = {
        mode: "live",
        enabled: true,
        model: "mock",
        running: 0,
        queued: 0,
        pendingApprovals: 0,
        connectors: [],
        execution: {
          provider: "local",
          capabilities: { shell: true, browser: true, computer: false },
        },
        placement: {
          placement: "always_on_host",
          runsOn: { deviceId: "dev_vm", name: "vm-1", thisDevice: true, alwaysOnMachine: true },
          relay: "off",
        },
        readiness: {
          harness: { kind: "cursor", ready: true },
          modelCredential: true,
          browser: true,
          computer: "unsupported",
          connectors: { configured: 1, connected: 1 },
        },
      };
      send(200, status);
      return;
    }
    const revoke = /^\/api\/devices\/([^/]+)$/.exec(path);
    if (req.method === "DELETE" && revoke) {
      const id = decodeURIComponent(revoke[1] ?? "");
      machine.revoked.push(id);
      for (const [token, owner] of tokens) if (owner === id) tokens.delete(token);
      send(204);
      return;
    }
    send(404, { error: "not_found", message: "Unknown API route" });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen({ port: 0, host: "127.0.0.1" }, resolve));
  machine.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return machine;
}
