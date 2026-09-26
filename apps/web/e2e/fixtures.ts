import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { test as base, expect } from "@playwright/test";
import { E2E_PORT } from "./ports";

/**
 * Real daemons for the specs, started by the harness Playwright runs as its web server
 * (packages/agent/scripts/e2e-daemons.ts, where `DaemonSpec` is documented). Every test gets its
 * own daemon (`daemon`, configured with `test.use({ daemonSpec })`) and the pages open its URL.
 */
export interface DaemonSpec {
  agent?: "mock" | "live" | "off";
  noKey?: boolean;
  vault?: "demo" | "empty";
  notes?: number;
  files?: Record<string, string>;
  settings?: Record<string, unknown>;
  config?: Record<string, unknown>;
  env?: Record<string, string>;
  device?: string;
  sync?: SyncVault;
  obsidian?: boolean;
  web?: boolean;
  lockVault?: boolean;
}

export interface SyncVault {
  url: string;
  vault: string;
  token: string;
}

interface Started {
  id: string;
  url: string;
  port: number;
  token: string;
  root: string;
  home: string;
  vault: string;
  obsidian?: string;
}

const HARNESS = `http://127.0.0.1:${E2E_PORT}`;

async function harness<T>(method: string, path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${HARNESS}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`e2e harness ${method} ${path}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}

export class Daemon {
  readonly id: string;
  readonly url: string;
  readonly port: number;
  readonly token: string;
  /** Where its files are: `home` (DDL_HOME), `vault`, and `obsidian` when asked for. */
  readonly root: string;
  readonly home: string;
  readonly vault: string;
  readonly obsidian: string | undefined;

  constructor(started: Started) {
    this.id = started.id;
    this.url = started.url;
    this.port = started.port;
    this.token = started.token;
    this.root = started.root;
    this.home = started.home;
    this.vault = started.vault;
    this.obsidian = started.obsidian;
  }

  /** A vault file's content, or null when it doesn't exist. */
  async read(path: string): Promise<string | null> {
    return readFile(join(this.vault, path), "utf8").catch(() => null);
  }

  /**
   * Writes a vault file on disk, as another app (or sync) would: the daemon sees it change. The
   * write is atomic (a hidden temporary file renamed into place), so the daemon never reads it
   * half-written.
   */
  async write(path: string, content: string): Promise<void> {
    const file = join(this.vault, path);
    await mkdir(dirname(file), { recursive: true });
    const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
    await writeFile(temporary, content);
    await rename(temporary, file);
  }

  /** Deletes a vault file on disk, as another app would. */
  async remove(path: string): Promise<void> {
    await rm(join(this.vault, path), { force: true });
  }

  /** The vault's notes and files (not hidden ones), as vault paths. */
  async list(): Promise<string[]> {
    const entries = await readdir(this.vault, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(this.vault, join(entry.parentPath, entry.name)))
      .filter((path) => !path.split("/").some((part) => part.startsWith(".")));
  }

  /** Calls the daemon's API with its master token. */
  async api<T = unknown>(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.url}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  }

  /** The daemon goes down (its port closes), as when a machine stops. */
  async stop(): Promise<void> {
    await harness("POST", `/daemons/${this.id}/stop`);
  }

  /** It comes back: same home, vault and port. */
  async start(): Promise<void> {
    await harness("POST", `/daemons/${this.id}/start`);
  }

  async close(): Promise<void> {
    await harness("DELETE", `/daemons/${this.id}`);
  }
}

export async function startDaemon(spec: DaemonSpec = {}): Promise<Daemon> {
  return new Daemon(await harness<Started>("POST", "/daemons", spec));
}

interface SeededMessage {
  id: string;
  kind: "text";
  role: "agent" | "user";
  author: "orchestrator" | "you" | `subagent:${string}`;
  createdAt: number;
  text: string;
}

/**
 * A finished agent thread as the daemon stores it (`.daily-do-list/threads/<id>.json`, format v1
 * in @ddl/contract), for `DaemonSpec.files`.
 */
export function threadFile(thread: {
  id: string;
  title: string;
  messages: SeededMessage[];
}): Record<string, string> {
  const at = thread.messages.at(-1)?.createdAt ?? Date.now();
  const file = {
    version: 1,
    taskId: null,
    notePath: null,
    status: "done",
    createdAt: thread.messages[0]?.createdAt ?? at,
    updatedAt: at,
    artifacts: [],
    surfaces: [],
    ...thread,
  };
  return { [`.daily-do-list/threads/${thread.id}.json`]: `${JSON.stringify(file)}\n` };
}

/** A new vault on the harness's sync service, with its token. */
export function syncVault(): Promise<SyncVault> {
  return harness<SyncVault>("POST", "/sync-vaults");
}

export const test = base.extend<{
  daemonSpec: DaemonSpec;
  daemon: Daemon;
  /** More daemons for the test (another device, the always-on machine), removed after it. */
  launch: (spec?: DaemonSpec) => Promise<Daemon>;
}>({
  daemonSpec: [{}, { option: true }],
  daemon: async ({ daemonSpec }, use) => {
    const daemon = await startDaemon(daemonSpec);
    await use(daemon);
    await daemon.close();
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from it.
  launch: async ({}, use) => {
    const started: Daemon[] = [];
    await use(async (spec) => {
      const daemon = await startDaemon(spec);
      started.push(daemon);
      return daemon;
    });
    await Promise.all(started.map((daemon) => daemon.close()));
  },
  baseURL: async ({ daemon }, use) => {
    await use(daemon.url);
  },
});

export type { Browser, Locator, Page } from "@playwright/test";
export { expect };
