// Checks a running bundle for smoke-test.sh: the sync service, the daemon's API and web app, the
// daemon syncing through the sync service, and its agent running here (holding the agent lease).
// Tokens are read from files, sent only to loopback, and never printed.
//
//   node smoke-check.mjs --daemon <url> --token-file <daemon-token> --sync <url>
//        --sync-vault <vault id> --sync-token-file <sync-token>
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    daemon: { type: "string" },
    "token-file": { type: "string" },
    sync: { type: "string" },
    "sync-vault": { type: "string" },
    "sync-token-file": { type: "string" },
  },
  strict: true,
});
for (const flag of ["daemon", "token-file", "sync", "sync-vault", "sync-token-file"]) {
  if (!values[flag]) throw new Error(`--${flag} is required`);
}
const daemon = values.daemon.replace(/\/$/, "");
const sync = values.sync.replace(/\/$/, "");
const auth = { authorization: `Bearer ${readFileSync(values["token-file"], "utf8").trim()}` };
const syncAuth = {
  authorization: `Bearer ${readFileSync(values["sync-token-file"], "utf8").trim()}`,
};
const WAIT_MS = 30_000;
const NOTE = "smoke-test.md";

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

await check("daemon: its agent runs here (holds the agent lease)", async () => {
  let last;
  await eventually("the agent running", async () => {
    last = (await http(`${daemon}/api/agent/status`, { headers: auth })).json();
    return last?.mode === "mock" && last.problem === undefined;
  }).catch((error) => {
    throw new Error(`${error.message} (problem: ${last?.problem ?? "none"})`);
  });
});

// ── FOLLOW-UP for the lead: pairing, once remote access (S1) is merged ──────────────────────────
// smoke-test.sh already starts the daemon with DDL_REMOTE_HOSTS=vm-name.tailnet-name.ts.net. Pass
// that name here (a --remote-host flag) and add these checks, all with `host: <remote host>`:
//   1. GET /  → 200 with <meta name="ddl-auth" content="pairing"> and no ddl-token meta.
//   2. A code from the headless CLI, as on the VM (same env as the daemon in smoke-test.sh):
//        DDL_HOME=<ddl home> node <bundle>/daemon/dist/main.js pair
//      → prints the code (XXXX-XXXX), its expiry and https://vm-name.tailnet-name.ts.net; or
//      POST /api/pairing-codes { name: "smoke" } with the master token → 201 { code, expiresAt, url }.
//   3. POST /api/pair { code, name: "smoke", kind: "app" }, no Authorization → 201 { device, token }.
//      The same code again → 401.
//   4. GET /api/health with `Authorization: Bearer <device token>` → 200; GET /api/devices (master
//      token) lists "smoke"; DELETE /api/devices/<device id> → 204; the device token → 401.

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

async function eventually(what, probe) {
  const deadline = Date.now() + WAIT_MS;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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
