/** Realistic values mixed with edge cases for the wire primitives (see `REALISTIC` in arbitraries). */
import {
  isMachineUrl,
  isRemoteHost,
  normalizeDeviceName,
  ORCHESTRATOR_THREAD_ID,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  REMOTE_LIMITS,
  SYNC_LIMITS,
} from "@ddl/core";
import fc from "fast-check";
import { WIRE_LIMITS } from "../wire/primitives";

/** Keeps values whose UTF-16 length (what zod's `max` counts) is within bounds. */
export function lengthWithin(arb: fc.Arbitrary<string>, min: number, max: number) {
  return arb.filter((s) => s.length >= min && s.length <= max);
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const RUNTIME_ID_CHARS = `${ID_ALPHABET}ABCDEFGHIJKLMNOPQRSTUVWXYZ_.:-`;
const CLIENT_ID_CHARS = `${ID_ALPHABET}ABCDEFGHIJKLMNOPQRSTUVWXYZ_-`;

const chars = (alphabet: string) => fc.constantFrom(...alphabet.split(""));

/** `createId(prefix)`-style ids: `thr_k3j9x0q2m1ab`. */
const createdId = (prefix: string, length = 12) =>
  fc
    .string({ unit: chars(ID_ALPHABET), minLength: length, maxLength: length })
    .map((suffix) => `${prefix}_${suffix}`);

/** URL-safe runtime ids, including the 1- and 200-character extremes (never `.` or `..`). */
export const runtimeId = (prefix = "thr") =>
  fc.oneof(
    { weight: 6, arbitrary: createdId(prefix) },
    {
      weight: 2,
      arbitrary: fc
        .string({ unit: chars(RUNTIME_ID_CHARS), minLength: 1, maxLength: 40 })
        .filter((id) => id !== "." && id !== ".."),
    },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        "a",
        "x".repeat(WIRE_LIMITS.idLength),
        "a.b:c-d_e",
        ORCHESTRATOR_THREAD_ID,
      ),
    },
  );

export const clientId = () =>
  fc.oneof(
    { weight: 6, arbitrary: createdId("web") },
    {
      weight: 1,
      arbitrary: fc.string({ unit: chars(CLIENT_ID_CHARS), minLength: 1, maxLength: 128 }),
    },
    { weight: 1, arbitrary: fc.constantFrom("a", "c".repeat(WIRE_LIMITS.clientIdLength)) },
  );

/** Epoch milliseconds: realistic, zero and the largest safe integer. */
export const epochMs = () =>
  fc.oneof(
    { weight: 8, arbitrary: fc.integer({ min: 1_600_000_000_000, max: 2_100_000_000_000 }) },
    { weight: 1, arbitrary: fc.constantFrom(0, 1, Number.MAX_SAFE_INTEGER) },
    { weight: 1, arbitrary: fc.maxSafeNat() },
  );

/** Integers in `[min, max]`: mostly small, plus both bounds. */
export const integer = (min: number, max: number) =>
  fc.oneof(
    { weight: 8, arbitrary: fc.integer({ min, max: Math.min(max, min + 500) }) },
    { weight: 1, arbitrary: fc.constantFrom(min, max) },
    { weight: 1, arbitrary: fc.integer({ min, max }) },
  );

/** A finite number without `-0` (which JSON turns into `0`). */
export const finiteNumber = (min = -1e6, max = 1e6) =>
  fc
    .oneof(
      fc.integer({ min: Math.ceil(min), max: Math.floor(max) }),
      fc.double({ min, max, noNaN: true }),
    )
    .map((n) => (n === 0 ? 0 : n));

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Valid calendar dates: realistic years, leap days and the 4-digit extremes. */
export const isoDate = () =>
  fc.oneof(
    {
      weight: 8,
      arbitrary: fc
        .date({
          min: new Date("1990-01-01T00:00:00Z"),
          max: new Date("2099-12-31T00:00:00Z"),
          noInvalidDate: true,
        })
        .map((d) => d.toISOString().slice(0, 10)),
    },
    {
      weight: 2,
      arbitrary: fc.constantFrom(
        "2024-02-29",
        "2000-02-29",
        "2100-02-28",
        "1999-12-31",
        "0001-01-01",
        "9999-12-31",
      ),
    },
    {
      weight: 1,
      arbitrary: fc
        .record({
          year: fc.integer({ min: 1, max: 9999 }),
          month: fc.integer({ min: 1, max: 12 }),
          day: fc.integer({ min: 1, max: 28 }),
        })
        .map(({ year, month, day }) => `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`),
    },
  );

const REALISTIC_TEXT = [
  "Find a dentist",
  "Book dentist appointment next week",
  "Research best standing desks under $500",
  "Email the landlord about the heater",
  "Plan a picnic ☀️",
  "Réserver une table 🍝",
  "预约牙医",
  "Позвонить маме",
  "**Bold**, _italic_ and `code` with [[Wiki link]]",
  "- [ ] Find a dentist\n- [x] Paid rent\n",
  "Line one\nLine two\r\nLine three",
  "Tab\tseparated\u00a0nbsp",
  "👩‍👩‍👧‍👦 family emoji and e\u0301 combining accent",
];

/** Free text: realistic, empty, ASCII, graphemes and raw code points (controls, astral). */
export const text = (maxLength = 2_000) =>
  lengthWithin(
    fc.oneof(
      { weight: 4, arbitrary: fc.constantFrom(...REALISTIC_TEXT) },
      { weight: 2, arbitrary: fc.string({ maxLength: 80 }) },
      { weight: 2, arbitrary: fc.string({ unit: "grapheme", maxLength: 30 }) },
      { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 30 }) },
      { weight: 1, arbitrary: fc.constant("") },
    ),
    0,
    maxLength,
  );

/** Non-empty text without surrounding whitespace (what trimming schemas output). */
export const trimmedText = (maxLength = 2_000) =>
  text(maxLength)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const SEGMENTS = [
  "Daily",
  "Projects",
  "Garden Redesign",
  "Café ☕",
  "100% done",
  "a#b?c&d=e",
  "déjà vu",
  "日本語",
  "emoji 🎉",
  "[brackets] (parens)",
  "plus+sign",
];

/** One visible path segment (no `/`, `\`, NUL, and not starting with a dot). */
export const segment = () =>
  fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...SEGMENTS) },
    {
      weight: 2,
      arbitrary: fc
        .string({ unit: "grapheme", minLength: 1, maxLength: 12 })
        .filter((s) => !/[/\\\0]/.test(s) && !s.startsWith(".") && s.trim() === s && s.length > 0),
    },
  );

const TEXT_EXTENSIONS = [".md", ".md", ".md", ".txt", ".markdown", ".canvas", ".json", ".yaml"];

/** A canonical, visible text-note path like `Daily/2026-09-23.md`. */
export const notePath = () =>
  fc
    .tuple(fc.array(segment(), { maxLength: 3 }), segment(), fc.constantFrom(...TEXT_EXTENSIONS))
    .map(([folders, name, ext]) => [...folders, `${name}${ext}`].join("/"))
    .filter((p) => p.length <= WIRE_LIMITS.requestPathLength);

/** A canonical, visible folder path. */
export const folderPath = () =>
  fc
    .array(segment(), { minLength: 1, maxLength: 3 })
    .map((parts) => parts.join("/"))
    .filter((p) => p.length <= WIRE_LIMITS.requestPathLength);

/** Any canonical vault path the daemon may report, including hidden and sidecar ones. */
export const vaultPath = () =>
  fc.oneof(
    { weight: 6, arbitrary: notePath() },
    { weight: 2, arbitrary: folderPath() },
    {
      weight: 1,
      arbitrary: fc.constantFrom(".trash/Old.md", ".daily-do-list/artifacts/thr_1/art_1.md", "a"),
    },
  );

/** A vault path as a client sends it: canonical, or one the daemon normalizes or refuses. */
export const requestPath = () =>
  fc.oneof(
    { weight: 6, arbitrary: notePath() },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        "Daily//2026-09-23.md",
        "./a.md",
        "a\\b.md",
        "p".repeat(WIRE_LIMITS.requestPathLength),
      ),
    },
  );

/** Tool inputs: realistic argument objects and JSON that survives a round trip (no `-0`). */
export const toolInput = () =>
  fc.oneof(
    {
      weight: 3,
      arbitrary: fc.constantFrom<unknown>(
        { query: "best kettles 2026" },
        { url: "https://example.com/checkout", element: "Place order button" },
        { to: "landlord@example.com", subject: "Heater", body: "Hi — the heater is broken." },
        {},
      ),
    },
    {
      weight: 1,
      arbitrary: fc.jsonValue({ maxDepth: 3 }).map((v) => JSON.parse(JSON.stringify(v)) as unknown),
    },
  );

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** 1×1 grey JPEG (the web mock's fallback frame). */
export const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

/** Padded base64 of 1..512 random bytes, or a real JPEG. */
export const base64 = () =>
  fc.oneof(
    fc.uint8Array({ minLength: 1, maxLength: 512 }).map(toBase64),
    fc.constant(TINY_JPEG_BASE64),
  );

const modelIdOf = (known: string[], filler: string) =>
  fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...known) },
    { weight: 1, arbitrary: trimmedText(WIRE_LIMITS.modelIdLength) },
    { weight: 1, arbitrary: fc.constant(filler.repeat(WIRE_LIMITS.modelIdLength)) },
  );

/** A model id without surrounding whitespace. */
export const modelId = () =>
  modelIdOf(
    ["deepseek/deepseek-v4.1-flash", "mock", "openai/gpt-5.2", "anthropic/claude-opus-4.5"],
    "m",
  );

/** A Cursor CLI model id, optionally with parameters, without surrounding whitespace. */
export const cursorModelId = () =>
  modelIdOf(
    ["composer-2.5", "gpt-5.5", "gpt-5.5[reasoning=high]", "claude-4.5-sonnet-thinking"],
    "c",
  );

const DEVICE_NAMES = ["Work laptop", "MacBook Pro", "vm-name", "iPhone", "Café ☕", "Büro-PC"];

/** A device or machine name as `normalizeDeviceName` returns it (1–64 characters). */
export const deviceName = (max: number = REMOTE_LIMITS.deviceNameLength) =>
  fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...DEVICE_NAMES) },
    {
      weight: 2,
      arbitrary: fc
        .string({ unit: "grapheme", minLength: 1, maxLength: 24 })
        .filter((name) => normalizeDeviceName(name) === name && name.length <= max),
    },
    { weight: 1, arbitrary: fc.constantFrom("x", "n".repeat(max)) },
  );

/** A device name as the sync service knows it (up to 100 characters). */
export const syncDeviceName = () => deviceName(SYNC_LIMITS.deviceNameLength);

/** A sync device id: `dev_` and 20 characters, plus the 1- and 64-character extremes. */
export const syncDeviceId = () =>
  fc.oneof(
    { weight: 6, arbitrary: createdId("dev", 20) },
    { weight: 1, arbitrary: fc.constantFrom("d", "D".repeat(64), "dev_A-b_9") },
  );

/** `host[:port]` as a daemon reports its remote hosts (lowercase DNS names). */
export const remoteHost = () =>
  fc.oneof(
    {
      weight: 4,
      arbitrary: fc.constantFrom(
        "vm-name.tailnet-name.ts.net",
        "vm-name.tailnet-name.ts.net:8443",
        "always-on.example.com",
        "vm-1",
      ),
    },
    { weight: 2, arbitrary: fc.domain().filter(isRemoteHost) },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.domain(), fc.integer({ min: 1, max: 65_535 }))
        .map(([host, port]) => `${host}:${port}`)
        .filter(isRemoteHost),
    },
  );

/** A machine URL in its normalized form: `https://<remote host>`, or plain http to loopback. */
export const machineUrl = () =>
  fc.oneof(
    { weight: 6, arbitrary: httpsMachineUrl() },
    {
      weight: 1,
      arbitrary: fc.constantFrom(
        "http://127.0.0.1:7400",
        "http://localhost:7400",
        "http://[::1]:7400",
        "https://127.0.0.1:8443",
      ),
    },
  );

export const httpsMachineUrl = () =>
  remoteHost()
    .map((host) => `https://${host}`)
    .filter(isMachineUrl);

/** A pairing code as the daemon issues it: 8 characters of the unambiguous alphabet. */
export const pairingCode = () =>
  fc.string({
    unit: chars(PAIRING_CODE_ALPHABET),
    minLength: PAIRING_CODE_LENGTH,
    maxLength: PAIRING_CODE_LENGTH,
  });

/** A pairing code as a user types it: canonical, `XXXX-XXXX` or lowercase. */
export const pairingCodeInput = () =>
  fc.oneof(
    pairingCode(),
    pairingCode().map((code) => `${code.slice(0, 4)}-${code.slice(4)}`),
    pairingCode().map((code) => code.toLowerCase()),
  );
