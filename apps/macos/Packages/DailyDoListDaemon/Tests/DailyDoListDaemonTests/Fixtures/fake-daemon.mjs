// A stand-in for apps/daemon used by the supervisor's real-process tests. Like the real daemon it
// reuses or creates `$DDL_HOME/daemon-token` (0600), serves GET /api/health on 127.0.0.1:$DDL_PORT
// behind the bearer token, logs to stdout/stderr and exits on SIGTERM.
//
// Knobs (environment):
//   FAKE_DAEMON_CRASH_AFTER_MS   exit with status 3 this long after listening
//   FAKE_DAEMON_CRASH_TIMES      only crash on the first N runs (counted in $DDL_HOME)
//   FAKE_DAEMON_IGNORE_SIGTERM=1 ignore SIGTERM (the supervisor must escalate to SIGKILL)
//   FAKE_DAEMON_STARTUP_DELAY_MS wait before listening
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const home = process.env.DDL_HOME;
const port = Number(process.env.DDL_PORT);
if (!home || !Number.isInteger(port) || port <= 0) {
  console.error("fake daemon: DDL_HOME and DDL_PORT are required");
  process.exit(2);
}
mkdirSync(home, { recursive: true, mode: 0o700 });

function loadOrCreateToken() {
  const path = join(home, "daemon-token");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

function shouldCrash() {
  if (!process.env.FAKE_DAEMON_CRASH_AFTER_MS) return false;
  const limit = process.env.FAKE_DAEMON_CRASH_TIMES;
  if (limit === undefined) return true;
  const counter = join(home, "fake-daemon-crashes");
  const crashes = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  if (crashes >= Number(limit)) return false;
  writeFileSync(counter, String(crashes + 1));
  return true;
}

const token = loadOrCreateToken();

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  if (req.url !== "/api/health") return json(res, 404, { error: "not_found" });
  if (req.headers.authorization !== `Bearer ${token}`) {
    return json(res, 401, { error: "unauthorized", message: "Missing or invalid bearer token" });
  }
  json(res, 200, {
    ok: true,
    version: "0.0.0-fake",
    apiVersion: 1,
    vaultName: "Fake",
    agentMode: "mock",
  });
});

server.on("error", (error) => {
  const reason = error.code === "EADDRINUSE" ? `Port ${port} is already in use.` : error.message;
  console.error(`fake daemon failed to start: ${reason}`);
  process.exit(1);
});

process.on("SIGTERM", () => {
  if (process.env.FAKE_DAEMON_IGNORE_SIGTERM === "1") {
    console.log("fake daemon ignoring SIGTERM");
    return;
  }
  console.log("fake daemon received SIGTERM");
  server.close();
  process.exit(0);
});

setTimeout(
  () => {
    server.listen(port, "127.0.0.1", () => {
      console.log(`fake daemon listening on http://127.0.0.1:${port} (pid ${process.pid})`);
      console.error("fake daemon stderr line");
      if (shouldCrash()) {
        setTimeout(() => {
          console.error("fake daemon crashing on purpose");
          process.exit(3);
        }, Number(process.env.FAKE_DAEMON_CRASH_AFTER_MS));
      }
    });
  },
  Number(process.env.FAKE_DAEMON_STARTUP_DELAY_MS ?? 0),
);
