// Checks a running bundle, for smoke-test.sh (unpacked, mock agent) and setup-test.sh (installed
// under systemd): the sync service; the daemon's API, guards and web app; a note syncing through
// the sync service; the agent running here as the always-on machine (placement, lease); and
// remote access, with requests shaped like `tailscale serve`'s: the pairing screen on the remote
// Host, the `pair` / `devices` / `revoke` CLI, POST /api/pair, the device token, and revocation.
// Tokens are read from files or responses, sent only to loopback, and never printed.
//
//   node smoke-check.mjs --daemon <url> --token-file <daemon-token> --sync <url>
//        --sync-vault <vault id> --sync-token-file <sync-token> --bundle <bundle dir>
//        --remote-host <name> [--cli-env NAME=VALUE]...
//
// The CLI runs as `node <bundle>/daemon/dist/main.js`, from this process's working directory with
// its environment plus --cli-env (e.g. DDL_HOME, and DDL_PORT when the daemon picked a free port).
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    daemon: { type: "string" },
    "token-file": { type: "string" },
    sync: { type: "string" },
    "sync-vault": { type: "string" },
    "sync-token-file": { type: "string" },
    bundle: { type: "string" },
    "remote-host": { type: "string" },
    "cli-env": { type: "string", multiple: true, default: [] },
  },
  strict: true,
});
const REQUIRED = [
  "daemon",
  "token-file",
  "sync",
  "sync-vault",
  "sync-token-file",
  "bundle",
  "remote-host",
];
for (const flag of REQUIRED) {
  if (!values[flag]) throw new Error(`--${flag} is required`);
}
const daemon = values.daemon.replace(/\/$/, "");
const sync = values.sync.replace(/\/$/, "");
const remoteHost = values["remote-host"];
const auth = bearer(readFileSync(values["token-file"], "utf8").trim());
const syncAuth = bearer(readFileSync(values["sync-token-file"], "utf8").trim());
const cliEnv = Object.fromEntries(
  values["cli-env"].map((entry) => {
    const at = entry.indexOf("=");
    if (at < 1) throw new Error(`--cli-env takes NAME=VALUE (got "${entry}")`);
    return [entry.slice(0, at), entry.slice(at + 1)];
  }),
);
const WAIT_MS = 30_000;
const NOTE = "smoke-test.md";
const DEVICE_NAME = "smoke-check";
// Remote requests arrive the way `tailscale serve` forwards them: the remote Host kept, plus
// forwarding headers (which the daemon refuses only with a loopback Host).
const viaServe = {
  host: remoteHost,
  "x-forwarded-for": "192.0.2.10",
  "x-forwarded-host": remoteHost,
  "x-forwarded-proto": "https",
};

let failures = 0;

await check("sync service: /v1/health", async () => {
  const res = await http(`${sync}/v1/health`);
  expect(res.status === 200 && res.json()?.ok === true, `HTTP ${res.status}`);
});

await check("daemon: /api/health with the token", async () => {
  const res = await http(`${daemon}/api/health`, { headers: auth });
  const body = res.json();
  expect(res.status === 200 && body?.ok === true, `HTTP ${res.status}`);
  expect(body.agentMode === "mock", `agentMode ${body.agentMode}`);
});

await check("daemon: refuses a request without the token", async () => {
  const res = await http(`${daemon}/api/health`);
  expect(res.status === 401, `HTTP ${res.status}`);
});

await check("daemon: refuses a foreign Host", async () => {
  const res = await http(`${daemon}/`, { headers: { host: "evil.example" } });
  expect(res.status === 403, `HTTP ${res.status}`);
});

await check("daemon: refuses a loopback Host that a proxy forwarded", async () => {
  // A proxy that rewrote the Host to loopback would otherwise get the page's master token.
  const forwarded = { "x-forwarded-for": "192.0.2.10" };
  const page = await http(`${daemon}/`, { headers: forwarded });
  expect(page.status === 403, `GET /: HTTP ${page.status}`);
  expect(!page.text.includes("ddl-token"), "the refusal carries the token");
  const api = await http(`${daemon}/api/health`, { headers: { ...auth, ...forwarded } });
  expect(api.status === 403, `GET /api/health: HTTP ${api.status}`);
});

await check("daemon: serves the built web app to the loopback Host", async () => {
  const res = await http(`${daemon}/`);
  expect(res.status === 200, `HTTP ${res.status} (503 means no web/dist next to daemon/)`);
  expect(String(res.headers["content-type"]).startsWith("text/html"), "not HTML");
  expect(res.headers["cache-control"] === "no-store", "index.html must not be cached");
  expect(/<meta name="ddl-token" content="[0-9a-f]{64}">/.test(res.text), "no ddl-token meta");
  const script = /<script type="module"[^>]* src="(\/assets\/[^"]+\.js)"/.exec(res.text)?.[1];
  expect(script, "no module script");
  const asset = await http(`${daemon}${script}`);
  expect(asset.status === 200, `${script}: HTTP ${asset.status}`);
  expect(String(asset.headers["content-type"]).includes("javascript"), `${script}: not JavaScript`);
});

await check("daemon: syncs with the sync service", async () => {
  const status = (await http(`${daemon}/api/sync/status`, { headers: auth })).json();
  expect(status?.target === "remote", `sync target ${status?.target}`);
  expect(status.remoteHost === new URL(sync).host, `sync remoteHost ${status.remoteHost}`);
  const write = await http(`${daemon}/api/notes/${NOTE}`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ content: "Written by the bundle smoke test.\n", baseVersion: null }),
  });
  expect(write.status === 201, `PUT ${NOTE}: HTTP ${write.status}`);
  const url = `${sync}/v1/vaults/${values["sync-vault"]}/files/${NOTE}?meta=1`;
  await eventually(`${NOTE} on the sync service`, async () => {
    return (await http(url, { headers: syncAuth })).status === 200;
  });
});

await check("daemon: runs the agent as the always-on machine (placement, lease)", async () => {
  let last;
  await eventually("the agent lease", async () => {
    last = (await http(`${daemon}/api/agent/status`, { headers: auth })).json();
    const runsOn = last?.placement?.runsOn;
    return (
      last?.mode === "mock" &&
      last.problem === undefined &&
      last.placement.placement === "always_on_host" &&
      runsOn?.thisDevice === true &&
      runsOn.alwaysOnMachine === true
    );
  }).catch((error) => {
    const { placement, heldHere, runsOn } = last?.placement ?? {};
    const state = {
      placement,
      heldHere,
      thisDevice: runsOn?.thisDevice,
      host: runsOn?.alwaysOnMachine,
    };
    throw new Error(
      `${error.message} (${JSON.stringify(state)}, problem: ${last?.problem ?? "none"})`,
    );
  });
});

await check("remote Host: the page asks for pairing and carries no token", async () => {
  const res = await http(`${daemon}/`, { headers: viaServe });
  expect(res.status === 200, `HTTP ${res.status} (403: ${remoteHost} isn't in remote.hosts)`);
  expect(res.text.includes('<meta name="ddl-auth" content="pairing">'), "no pairing meta");
  expect(!res.text.includes("ddl-token"), "the page carries a token");
});

let code;
await check("pair CLI: prints a code, its expiry and the remote URL", async () => {
  const result = await cli(["pair", "--name", DEVICE_NAME]);
  expect(result.code === 0, `exit ${result.code}: ${result.stderr.trim()}`);
  code = /^Pairing code: ([2-9A-Z]{4}-[2-9A-Z]{4})$/m.exec(result.stdout)?.[1];
  expect(code, "no XXXX-XXXX code in the output");
  expect(/^Valid once, until \d{2}:\d{2} /m.test(result.stdout), "no expiry in the output");
  expect(result.stdout.includes(`https://${remoteHost}`), `no https://${remoteHost} in the output`);
});

let device;
let deviceAuth;
await check("POST /api/pair: the code gets a device token, once", async () => {
  expect(code, "no pairing code");
  const pair = () =>
    http(`${daemon}/api/pair`, {
      method: "POST",
      headers: { ...viaServe, "content-type": "application/json" },
      body: JSON.stringify({ code, name: DEVICE_NAME, kind: "app" }),
    });
  const res = await pair();
  const body = res.json();
  expect(res.status === 201, `HTTP ${res.status} ${body?.error ?? ""}`);
  expect(typeof body.token === "string" && body.token.length >= 32, "no device token");
  expect(body.device?.name === DEVICE_NAME && body.device.kind === "app", "unexpected device");
  device = body.device;
  deviceAuth = bearer(body.token);
  const again = await pair();
  expect(again.status === 401, `the used code answered HTTP ${again.status}`);
});

await check("device token: works as a bearer token on the remote Host", async () => {
  expect(deviceAuth, "no device token");
  const res = await http(`${daemon}/api/health`, { headers: { ...deviceAuth, ...viaServe } });
  expect(res.status === 200 && res.json()?.ok === true, `HTTP ${res.status}`);
});

await check("devices CLI: lists the new device", async () => {
  expect(device, "no device");
  const result = await cli(["devices"]);
  expect(result.code === 0, `exit ${result.code}: ${result.stderr.trim()}`);
  expect(result.stdout.includes(device.id) && result.stdout.includes(DEVICE_NAME), "not listed");
});

await check("revoke CLI: cuts the device token off, and reports usage errors", async () => {
  expect(device && deviceAuth, "no device");
  const usage = await cli(["revoke"]);
  expect(usage.code === 2, `revoke without an id: exit ${usage.code}`);
  const unknown = await cli(["revoke", "dev_unknown"]);
  expect(unknown.code === 1, `revoke of an unknown device: exit ${unknown.code}`);
  const result = await cli(["revoke", device.id]);
  expect(result.code === 0, `exit ${result.code}: ${result.stderr.trim()}`);
  const res = await http(`${daemon}/api/health`, { headers: { ...deviceAuth, ...viaServe } });
  expect(res.status === 401, `the revoked token answered HTTP ${res.status}`);
});

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}

async function check(name, run) {
  try {
    await run();
    console.log(`ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function eventually(what, probe) {
  const deadline = Date.now() + WAIT_MS;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Runs the daemon's CLI; resolves with its exit code and output (which never holds a token). */
function cli(args) {
  const main = join(values.bundle, "daemon", "dist", "main.js");
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [main, ...args],
      { env: { ...process.env, ...cliEnv }, timeout: 20_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function http(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, timeout: 10_000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          json: () => {
            try {
              return JSON.parse(text);
            } catch {
              return undefined;
            }
          },
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${method} ${url} timed out`)));
    req.on("error", reject);
    req.end(body);
  });
}
