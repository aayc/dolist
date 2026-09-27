/** Isolated real-daemon + HTTPS proxy for manual iPhone Simulator QA. Synthetic data only.
 * Trust the generated CA only in the chosen test simulator, never the Mac's login keychain.
 * Run from the repo: pnpm exec tsx apps/mobile/scripts/mock-host.ts
 */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { silentLogger } from "../../../packages/core/src/logger";
import { loadConfig } from "../../daemon/src/config";
import { prepareDemo } from "../../daemon/src/demo-vault";
import { startDaemon } from "../../daemon/src/server";

const resume = process.argv[2] === "--resume" ? process.argv[3] : undefined;
if (resume && !basename(resume).startsWith("ddl-iphone-qa-"))
  throw new Error("Only a generated QA workspace can resume");
const root = resume ?? (await mkdtemp(join(tmpdir(), "ddl-iphone-qa-")));
const prior: { origin: string } | undefined = resume
  ? JSON.parse(await readFile(join(root, "qa.json"), "utf8"))
  : undefined;
await chmod(root, 0o700);
const tls = join(root, "tls");
await mkdir(tls, { mode: 0o700, recursive: true });
if (!resume) {
  await writeFile(
    join(tls, "ca.cnf"),
    `[req]
distinguished_name=dn
x509_extensions=ca
prompt=no
[dn]
CN=Daily Do List disposable Simulator QA
[ca]
basicConstraints=critical,CA:true
keyUsage=critical,keyCertSign,cRLSign
`,
  );
  await writeFile(
    join(tls, "server.cnf"),
    `[req]
distinguished_name=dn
prompt=no
[dn]
CN=localhost
[server]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
`,
  );
  function openssl(...args: string[]) {
    execFileSync("openssl", args, { cwd: tls, stdio: "ignore" });
  }
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "3",
    "-config",
    "ca.cnf",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
  );
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-config",
    "server.cnf",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
  );
  openssl(
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "3",
    "-sha256",
    "-extfile",
    "server.cnf",
    "-extensions",
    "server",
    "-out",
    "server.pem",
  );
}
let daemonPort: number | undefined;
const proxy = createServer(
  { key: await readFile(join(tls, "server.key")), cert: await readFile(join(tls, "server.pem")) },
  (request, response) => {
    if (!daemonPort) {
      response.writeHead(503).end();
      return;
    }
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: daemonPort,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      },
    );
    outgoing.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(outgoing);
  },
);
proxy.on("upgrade", (request, socket, head) => {
  if (!daemonPort) {
    socket.destroy();
    return;
  }
  const outgoing = httpRequest({
    host: "127.0.0.1",
    port: daemonPort,
    path: request.url,
    method: request.method,
    headers: request.headers,
  });
  outgoing.on("upgrade", (response, upstream, upstreamHead) => {
    const headers = response.rawHeaders.reduce<string[]>((lines, value, index, all) => {
      if (index % 2 === 0) lines.push(`${value}: ${all[index + 1]}`);
      return lines;
    }, []);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  outgoing.on("response", (response) => {
    socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`);
  });
  outgoing.on("error", () => socket.destroy());
  outgoing.end();
});
proxy.listen(prior ? Number(new URL(prior.origin).port) : 0, "127.0.0.1");
await once(proxy, "listening");
const origin = `https://localhost:${(proxy.address() as AddressInfo).port}`;
const env = {
  DDL_HOME: join(root, "home"),
  DDL_VAULT: join(root, "notes"),
  DDL_PORT: "0",
  DDL_AGENT_MODE: "mock",
};
await prepareDemo(env);
const config = loadConfig({ env, cwd: root });
config.allowedOrigins = [origin];
const daemon = await startDaemon({ config, env, logger: silentLogger });
daemonPort = daemon.port;
const token = (await readFile(config.tokenPath, "utf8")).trim();
const pairResponse = await fetch(`${daemon.url}/api/pairing-codes`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Simulator QA" }),
});
if (!pairResponse.ok) throw new Error(`Pairing setup failed: ${pairResponse.status}`);
await writeFile(join(root, "pairing.json"), JSON.stringify(await pairResponse.json()), {
  mode: 0o600,
});
await writeFile(
  join(root, "qa.json"),
  JSON.stringify({
    origin,
    daemonURL: daemon.url,
    root,
    pid: process.pid,
    ca: join(tls, "ca.pem"),
  }),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    origin,
    root,
    ca: join(tls, "ca.pem"),
    pairingFile: join(root, "pairing.json"),
  }),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  proxy.closeAllConnections();
  proxy.close();
  await daemon.close();
  process.exit(0);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
