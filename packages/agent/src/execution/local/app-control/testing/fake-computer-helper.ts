/**
 * A deterministic stand-in for the `ddl-computer` helper, spawned by the app-control tests (never
 * imported): `serve` speaks the helper's JSON-lines protocol over a few fake apps, each with one
 * window whose accessibility tree reacts to actions (Grok Bot answers what was sent to it).
 *
 * Running: Grok Bot (pid 501, frontmost), WhatsApp (502), Slack (503, hidden), 1Password (504,
 * protected), Daily Do List (505, protected). Installed only: Notes, ChatGPT, Microsoft Teams,
 * Grok (Next), Okta Verify and System Settings (the last two protected).
 *
 * Options go before or after `serve`:
 *   --fake-no-accessibility / --fake-no-screen   permission status (and matching refusals)
 *   --fake-version=<n>        hello version (default 1)
 *   --fake-crash-on=<method>  exit with code 3 when that method arrives
 *   --fake-hang-on=<method>   never answer that method
 *   --fake-exit-after=<n>     exit with code 0 after answering n requests
 *   --fake-noise              write junk lines (not JSON, unknown ids) around every answer
 *   --fake-log=<file>         append every request as a JSON line
 *   --fake-pids=<file>        append this process's pid on start
 *   --fake-env=<file>         write the environment variable names on start
 */
import { appendFileSync, writeFileSync } from "node:fs";

type Json = Record<string, unknown>;

interface FakeNode {
  role: string;
  name?: string;
  value?: string;
  settable?: boolean;
  actions?: string[];
  children?: FakeNode[];
  /** Pressing it (or its default action) runs this. */
  onPress?: (app: FakeApp) => void;
}

interface FakeApp {
  name: string;
  bundleId: string;
  pid: number;
  running: boolean;
  hidden: boolean;
  protected: boolean;
  path: string;
  window: { title: string; frame: { x: number; y: number; width: number; height: number } };
  tree: FakeNode;
}

interface Snapshot {
  id: string;
  pid: number;
  elements: Map<string, { node: FakeNode; frame: Json }>;
}

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const found = args.find((a) => a === `--fake-${name}` || a.startsWith(`--fake-${name}=`));
  return found === undefined ? undefined : (found.split("=")[1] ?? "1");
};
const accessibility = option("no-accessibility") === undefined;
const screenRecording = option("no-screen") === undefined;
const logFile = option("log");
let answered = 0;
let nextPid = 600;
let snapshotCounter = 0;
const snapshots = new Map<number, Snapshot>();

function field(name: string, extra: Partial<FakeNode> = {}): FakeNode {
  return { role: "AXTextArea", name, value: "", settable: true, actions: [], ...extra };
}

function button(name: string, onPress?: (app: FakeApp) => void): FakeNode {
  return { role: "AXButton", name, actions: ["press"], ...(onPress ? { onPress } : {}) };
}

function staticText(value: string): FakeNode {
  return { role: "AXStaticText", value };
}

function makeApp(
  name: string,
  bundleId: string,
  pid: number,
  tree: FakeNode,
  extra: Partial<FakeApp> = {},
): FakeApp {
  return {
    name,
    bundleId,
    pid,
    running: true,
    hidden: false,
    protected: false,
    path: `/Applications/${name}.app`,
    window: { title: tree.name ?? name, frame: { x: 100, y: 80, width: 900, height: 700 } },
    tree,
    ...extra,
  };
}

function grokTree(): FakeNode {
  const transcript: FakeNode = { role: "AXGroup", name: "Conversation", children: [] };
  const prompt = field("Ask anything");
  return {
    role: "AXWindow",
    name: "Grok",
    children: [
      transcript,
      prompt,
      button("Send", () => {
        if (!prompt.value) return;
        transcript.children!.push(staticText(`You: ${prompt.value}`));
        transcript.children!.push(staticText(`Grok: Here's what I found about ${prompt.value}.`));
        prompt.value = "";
      }),
    ],
  };
}

function chatTree(title: string): FakeNode {
  const messages: FakeNode = {
    role: "AXGroup",
    name: "Messages",
    children: [staticText("Sam: Are we still on for tonight?")],
  };
  const message = field("Message", { role: "AXTextField" });
  return {
    role: "AXWindow",
    name: title,
    children: [
      { role: "AXButton", name: "Sam", actions: ["press"] },
      messages,
      message,
      button("Send", () => {
        if (!message.value) return;
        messages.children!.push(staticText(`You: ${message.value}`));
        message.value = "";
      }),
      { role: "AXSecureTextField", name: "Passcode", value: "", settable: true },
    ],
  };
}

const apps: FakeApp[] = [
  makeApp("Grok Bot", "com.example.grokbot", 501, grokTree()),
  makeApp("WhatsApp", "com.example.whatsapp", 502, chatTree("WhatsApp")),
  makeApp("Slack", "com.example.slack", 503, chatTree("Slack"), { hidden: true }),
  makeApp("1Password", "com.1password.1password", 504, chatTree("1Password"), { protected: true }),
  makeApp("Daily Do List", "app.dailydolist.mac", 505, chatTree("Daily Do List"), {
    protected: true,
  }),
  makeApp("Notes", "com.apple.Notes", 0, chatTree("Notes"), {
    running: false,
    path: "/System/Applications/Notes.app",
  }),
  makeApp("ChatGPT", "com.example.chatgpt", 0, grokTree(), { running: false }),
  makeApp("Microsoft Teams", "com.example.teams", 0, chatTree("Teams"), { running: false }),
  makeApp("Grok (Next)", "com.example.groknext", 0, grokTree(), { running: false }),
  makeApp("Okta Verify", "com.example.oktaverify", 0, chatTree("Okta Verify"), {
    running: false,
    protected: true,
  }),
  makeApp("System Settings", "com.apple.systempreferences", 0, chatTree("System Settings"), {
    running: false,
    protected: true,
    path: "/System/Applications/System Settings.app",
  }),
];

class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function send(message: Json): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function noise(): void {
  if (option("noise") === undefined) return;
  process.stdout.write("not json at all\n");
  send({ id: 987654321, result: { stray: true } });
  send({ unrelated: "object" });
}

function num(params: Json, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RpcError("invalid", `\`${key}\` must be a number`);
  }
  return value;
}

function str(params: Json, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new RpcError("invalid", `\`${key}\` must be a string`);
  return value;
}

function running(): FakeApp[] {
  return apps.filter((app) => app.running);
}

function appByPid(pid: number): FakeApp {
  const app = running().find((candidate) => candidate.pid === pid);
  if (!app) throw new RpcError("not_found", `No running app has pid ${pid}.`);
  if (app.protected) throw new RpcError("protected", `${app.name} is protected.`);
  return app;
}

function needAccessibility(): void {
  if (!accessibility) throw new RpcError("permission", "Accessibility permission is missing.");
}

function resolveByName(query: string): FakeApp {
  const q = query.trim().toLowerCase();
  const exact = apps.filter((app) => app.name.toLowerCase() === q);
  const candidates =
    exact.length > 0
      ? exact
      : apps.filter((app) => app.name.toLowerCase().startsWith(q)).length > 0
        ? apps.filter((app) => app.name.toLowerCase().startsWith(q))
        : apps.filter((app) => app.name.toLowerCase().includes(q));
  if (candidates.length === 0) throw new RpcError("not_found", `No app named “${query}”.`);
  if (candidates.length > 1) {
    throw new RpcError(
      "invalid",
      `“${query}” matches several apps: ${candidates.map((app) => app.name).join(", ")}.`,
    );
  }
  return candidates[0]!;
}

function render(app: FakeApp): { id: string; text: string; elements: Json[] } {
  const snapshot: Snapshot = { id: `s${++snapshotCounter}`, pid: app.pid, elements: new Map() };
  const lines: string[] = [];
  const elements: Json[] = [];
  let counter = 0;
  const visit = (node: FakeNode, depth: number) => {
    const id = `e${++counter}`;
    const frame = {
      x: app.window.frame.x + 20,
      y: app.window.frame.y + 40 + counter * 30,
      width: 200,
      height: 24,
    };
    snapshot.elements.set(id, { node, frame });
    const secure = node.role === "AXSecureTextField";
    const value = secure ? (node.value ? "•••" : undefined) : node.value || undefined;
    const parts = [`[${id}] ${node.role}`];
    if (node.name) parts.push(`name=${JSON.stringify(node.name)}`);
    if (value !== undefined) parts.push(`value=${secure ? "•••" : JSON.stringify(value)}`);
    if (node.settable) parts.push("settable");
    if (node.actions?.length) parts.push(`actions=${node.actions.join(",")}`);
    lines.push(`${"  ".repeat(depth)}${parts.join(" ")}`);
    elements.push({
      id,
      role: node.role,
      ...(node.name ? { name: node.name } : {}),
      ...(value !== undefined ? { value } : {}),
      settable: node.settable === true,
      actions: node.actions ?? [],
      frame,
      enabled: true,
      focused: false,
    });
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(app.tree, 0);
  snapshots.set(app.pid, snapshot);
  return { id: snapshot.id, text: lines.join("\n"), elements };
}

function target(params: Json): { app: FakeApp; node: FakeNode; frame: Json } {
  const app = appByPid(num(params, "pid"));
  needAccessibility();
  const snapshot = snapshots.get(app.pid);
  const element = snapshot?.elements.get(str(params, "elementId"));
  if (!snapshot || snapshot.id !== str(params, "snapshotId") || !element) {
    throw new RpcError("stale", "That element is from an older snapshot.");
  }
  return { app, ...element };
}

function invalidate(pid: number): void {
  snapshots.delete(pid);
}

const IMAGE = Buffer.from("fake-jpeg-bytes").toString("base64");

function handle(method: string, params: Json): unknown {
  switch (method) {
    case "hello":
      return { version: Number(option("version") ?? 1), pid: process.pid };
    case "permissions":
      return { accessibility, screenRecording };
    case "apps":
      return {
        apps: running().map((app, index) => ({
          name: app.name,
          bundleId: app.bundleId,
          pid: app.pid,
          active: index === 0,
          hidden: app.hidden,
        })),
      };
    case "installedApps":
      return {
        apps: [...apps]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((app) => ({ name: app.name, bundleId: app.bundleId, path: app.path })),
      };
    case "resolveApp": {
      const app =
        typeof params.bundleId === "string"
          ? apps.find((candidate) => candidate.bundleId === params.bundleId)
          : typeof params.pid === "number"
            ? running().find((candidate) => candidate.pid === params.pid)
            : resolveByName(str(params, "name"));
      if (!app) throw new RpcError("not_found", "No such app.");
      if (app.protected) throw new RpcError("protected", `${app.name} is protected.`);
      const launched = !app.running;
      if (launched) {
        app.running = true;
        app.pid = nextPid++;
      }
      return { name: app.name, bundleId: app.bundleId, pid: app.pid, launched };
    }
    case "activate":
      appByPid(num(params, "pid"));
      return { ok: true };
    case "snapshot": {
      const app = appByPid(num(params, "pid"));
      needAccessibility();
      if (typeof params.elementId === "string") {
        const snapshot = snapshots.get(app.pid);
        if (!snapshot || snapshot.id !== params.snapshotId) {
          throw new RpcError("stale", "That snapshot is out of date.");
        }
      }
      const snapshot = render(app);
      return {
        snapshotId: snapshot.id,
        app: { name: app.name, bundleId: app.bundleId, pid: app.pid },
        window: { title: app.window.title, frame: app.window.frame },
        text: snapshot.text,
        elements: snapshot.elements,
        truncated: false,
      };
    }
    case "screenshot": {
      if (!screenRecording) {
        throw new RpcError("permission", "Screen Recording permission is missing.");
      }
      if (params.pid === undefined) {
        return {
          image: IMAGE,
          mimeType: "image/jpeg",
          width: 1280,
          height: 800,
          scale: 0.5,
          origin: { x: 0, y: 0 },
        };
      }
      const app = appByPid(num(params, "pid"));
      return {
        image: IMAGE,
        mimeType: "image/jpeg",
        width: 900,
        height: 700,
        scale: 1,
        origin: { x: app.window.frame.x, y: app.window.frame.y },
        app: { name: app.name, bundleId: app.bundleId, pid: app.pid },
        window: { title: app.window.title, frame: app.window.frame },
      };
    }
    case "press": {
      const { app, node } = target(params);
      const action = typeof params.action === "string" ? params.action : "press";
      if (!(node.actions ?? []).includes(action)) {
        throw new RpcError("unsupported", `The element can't ${action}.`);
      }
      node.onPress?.(app);
      invalidate(app.pid);
      return { ok: true, stale: true };
    }
    case "setValue": {
      const { node } = target(params);
      if (!node.settable) throw new RpcError("unsupported", "The element's value can't be set.");
      node.value = str(params, "value");
      return {
        ok: true,
        value: node.role === "AXSecureTextField" ? "•••" : node.value,
        stale: false,
      };
    }
    case "typeText": {
      const app = appByPid(num(params, "pid"));
      needAccessibility();
      const text = str(params, "text");
      if (typeof params.elementId === "string") {
        const { node } = target(params);
        const lines = text.split(/\r\n|\r|\n/);
        node.value = `${node.value ?? ""}${lines.pop() ?? ""}`;
      }
      invalidate(app.pid);
      return { ok: true, stale: true };
    }
    case "key": {
      const app = appByPid(num(params, "pid"));
      needAccessibility();
      str(params, "combo");
      invalidate(app.pid);
      return { ok: true, stale: true };
    }
    case "click": {
      const app = appByPid(num(params, "pid"));
      needAccessibility();
      const x = num(params, "x");
      const y = num(params, "y");
      const { frame } = app.window;
      if (x < frame.x || y < frame.y || x > frame.x + frame.width || y > frame.y + frame.height) {
        throw new RpcError("invalid", "The point is outside the app's windows.");
      }
      invalidate(app.pid);
      return { ok: true, stale: true };
    }
    case "scroll":
      appByPid(num(params, "pid"));
      needAccessibility();
      num(params, "dy");
      return { ok: true };
    default:
      throw new RpcError("invalid", `Unknown method ${method}.`);
  }
}

function onLine(line: string): void {
  if (!line.trim()) return;
  let request: Json;
  try {
    request = JSON.parse(line) as Json;
  } catch {
    process.stderr.write("fake-computer-helper: bad request line\n");
    return;
  }
  const id = request.id;
  const method = String(request.method);
  const params = (request.params ?? {}) as Json;
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ method, params })}\n`);
  if (option("crash-on") === method) process.exit(3);
  if (option("hang-on") === method) return;
  noise();
  try {
    send({ id, result: handle(method, params) });
  } catch (error) {
    const code = error instanceof RpcError ? error.code : "failed";
    send({ id, error: { code, message: error instanceof Error ? error.message : String(error) } });
  }
  answered++;
  const limit = option("exit-after");
  if (limit !== undefined && answered >= Number(limit)) process.exit(0);
}

const pidsFile = option("pids");
if (pidsFile) appendFileSync(pidsFile, `${process.pid}\n`);
const envFile = option("env");
if (envFile) writeFileSync(envFile, Object.keys(process.env).sort().join("\n"));

if (!args.includes("serve")) {
  process.stderr.write("usage: fake-computer-helper serve [--fake-…]\n");
  process.exit(2);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    onLine(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
