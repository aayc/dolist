// The parts of setup.sh that are easier to get right in Node than in shell: editing config.json,
// saving the sync token, reading JSON from other tools and waiting for health checks. Secrets
// arrive on stdin or in files and are written 0600; they never reach argv, stdout or stderr.
//
//   node setup-helper.mjs bundle <bundle dir>            prints "<release> <arch>"
//   node setup-helper.mjs tailnet-name                    < `tailscale status --json`
//   node setup-helper.mjs read-config --file <config.json> --key <dotted.key>
//   node setup-helper.mjs write-config --file <config.json> [--vault-path P] [--port N]
//        [--placement P] [--sync-url U --sync-vault V] [--remote-host NAME]...
//   node setup-helper.mjs has-vault --id <vault id>       < `ddl-sync vault list --json`
//   node setup-helper.mjs save-sync-token --file <path>   < `ddl-sync vault create|rotate-token --json`
//   node setup-helper.mjs wait-healthy --url <url> [--token-file <path>] [--timeout-s N]
//
// write-config fills in `vaultPath` and `port` only when they're unset, always sets
// `agent.placement` when given, and replaces `sync` and `remote.hosts` when given; every other key
// is kept. save-sync-token prints the vault id.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const PLACEMENTS = ["this_device", "always_on_machine", "always_on_host"];
const MAX_REMOTE_HOSTS = 8;
const SYNC_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RELEASE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

class UsageError extends Error {}

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "bundle":
      bundle(rest);
      break;
    case "tailnet-name":
      tailnetName();
      break;
    case "read-config":
      readConfigKey(rest);
      break;
    case "write-config":
      writeConfig(rest);
      break;
    case "has-vault":
      hasVault(rest);
      break;
    case "save-sync-token":
      saveSyncToken(rest);
      break;
    case "wait-healthy":
      await waitHealthy(rest);
      break;
    default:
      throw new UsageError(`unknown command "${command ?? ""}"`);
  }
} catch (error) {
  process.stderr.write(`setup-helper: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}

/** Prints the bundle's release id (`<version>-<commit>`, a safe directory name) and its CPU. */
function bundle(args) {
  const [dir] = args;
  if (!dir) throw new UsageError("bundle needs the bundle directory");
  const info = readJson(join(dir, "bundle.json"));
  if (!RELEASE.test(String(info?.release ?? ""))) {
    throw new Error(`${dir}/bundle.json has no valid release id`);
  }
  if (info.platform !== "linux" || !["x64", "arm64"].includes(info.arch)) {
    throw new Error(`${dir}/bundle.json isn't a Linux x64 or arm64 bundle`);
  }
  process.stdout.write(`${info.release} ${info.arch}\n`);
}

/** This machine's MagicDNS name, without the trailing dot; nothing when Tailscale has none. */
function tailnetName() {
  let status;
  try {
    status = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const name = typeof status?.Self?.DNSName === "string" ? status.Self.DNSName : "";
  const host = name.replace(/\.$/, "").toLowerCase();
  if (host && isRemoteHost(host)) process.stdout.write(`${host}\n`);
}

function readConfigKey(args) {
  const { values } = parse(args, { file: { type: "string" }, key: { type: "string" } });
  const config = readConfig(required(values.file, "--file"));
  let value = config;
  for (const part of required(values.key, "--key").split(".")) {
    if (Array.isArray(value) && /^\d+$/.test(part)) value = value[Number(part)];
    else value = isRecord(value) ? value[part] : undefined;
  }
  if (typeof value === "string" || typeof value === "number") process.stdout.write(`${value}\n`);
}

function writeConfig(args) {
  const { values } = parse(args, {
    file: { type: "string" },
    "vault-path": { type: "string" },
    port: { type: "string" },
    placement: { type: "string" },
    "sync-url": { type: "string" },
    "sync-vault": { type: "string" },
    "remote-host": { type: "string", multiple: true },
  });
  const file = required(values.file, "--file");
  const config = readConfig(file);

  if (values["vault-path"] !== undefined && config.vaultPath === undefined) {
    config.vaultPath = values["vault-path"];
  }
  if (values.port !== undefined && config.port === undefined) {
    const port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port < 1 || port > 65_535) {
      throw new UsageError("--port must be an integer from 1 to 65535");
    }
    config.port = port;
  }
  if (values.placement !== undefined) {
    if (!PLACEMENTS.includes(values.placement)) {
      throw new UsageError(`--placement must be one of ${PLACEMENTS.join(", ")}`);
    }
    config.agent = { ...(isRecord(config.agent) ? config.agent : {}), placement: values.placement };
  }
  if (values["sync-url"] !== undefined || values["sync-vault"] !== undefined) {
    const url = required(values["sync-url"], "--sync-url");
    const vault = required(values["sync-vault"], "--sync-vault");
    if (!SYNC_ID.test(vault)) throw new UsageError("--sync-vault is not a sync vault id");
    config.sync = { kind: "remote", url, vault };
  }
  if (values["remote-host"] !== undefined) {
    const hosts = [...new Set(values["remote-host"].map((host) => host.trim().toLowerCase()))];
    const invalid = hosts.filter((host) => !isRemoteHost(host));
    if (invalid.length > 0) {
      throw new UsageError(
        `not a DNS name (optionally with :port, no scheme, path or IP address): ${invalid.join(", ")}`,
      );
    }
    if (hosts.length > MAX_REMOTE_HOSTS) {
      throw new UsageError(`at most ${MAX_REMOTE_HOSTS} remote hosts`);
    }
    config.remote = { ...(isRecord(config.remote) ? config.remote : {}), hosts };
  }
  writePrivate(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** Exits 0 when the vault list on stdin contains the vault, else 1. */
function hasVault(args) {
  const { values } = parse(args, { id: { type: "string" } });
  const id = required(values.id, "--id");
  const vaults = JSON.parse(readFileSync(0, "utf8"));
  if (!Array.isArray(vaults) || !vaults.some((vault) => vault?.id === id)) process.exitCode = 1;
}

/** Saves the token of `{ "vault", "token" }` on stdin to the file (0600); prints the vault id. */
function saveSyncToken(args) {
  const { values } = parse(args, { file: { type: "string" } });
  const file = required(values.file, "--file");
  let created;
  try {
    created = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    throw new Error("expected the JSON printed by `ddl-sync vault create --json`");
  }
  const { vault, token } = isRecord(created) ? created : {};
  if (typeof vault !== "string" || !SYNC_ID.test(vault)) {
    throw new Error("no vault id in the input");
  }
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,}$/.test(token)) {
    throw new Error("no token in the input");
  }
  writePrivate(file, `${token}\n`);
  process.stdout.write(`${vault}\n`);
}

/** Polls a health endpoint until it answers 200 with `ok: true`. */
async function waitHealthy(args) {
  const { values } = parse(args, {
    url: { type: "string" },
    "token-file": { type: "string" },
    "timeout-s": { type: "string" },
  });
  const url = required(values.url, "--url");
  const tokenFile = values["token-file"];
  const deadline = Date.now() + Number(values["timeout-s"] ?? 30) * 1000;
  let last = "no answer";
  for (;;) {
    const headers = {};
    // The daemon creates its token on first start.
    if (tokenFile && existsSync(tokenFile)) {
      headers.authorization = `Bearer ${readFileSync(tokenFile, "utf8").trim()}`;
    } else if (tokenFile) {
      last = "no token file yet";
    }
    if (!tokenFile || headers.authorization) {
      try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
        const body = await response.json().catch(() => null);
        if (response.ok && body?.ok === true) return;
        last = `HTTP ${response.status}`;
      } catch (error) {
        last = error instanceof Error ? (error.cause?.code ?? error.message) : String(error);
      }
    }
    if (Date.now() >= deadline) throw new Error(`${url} isn't healthy (${last})`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function readConfig(file) {
  if (!existsSync(file)) return {};
  const config = readJson(file);
  if (!isRecord(config)) throw new Error(`${file} must contain a JSON object`);
  return config;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`can't read ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

/** Writes through a new 0600 file renamed over the target, so it is never briefly readable. */
function writePrivate(file, content) {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}

function isRemoteHost(value) {
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match || value.length > 253) return false;
  const [, host, port] = match;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) return false;
  const labels = host.split(".");
  if (labels.every((label) => /^\d+$/.test(label))) return false;
  return labels.length >= 2 && labels.every((label) => DNS_LABEL.test(label));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(args, options) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function required(value, flag) {
  if (!value?.trim()) throw new UsageError(`${flag} is required`);
  return value;
}
