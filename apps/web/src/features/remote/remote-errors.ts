import { HttpError, NetworkError } from "../../api/errors";

/** What was being done when a request failed, for wording its message. */
export type RemoteAction =
  | "load"
  | "placement"
  | "rename"
  | "remoteHosts"
  | "sync"
  | "syncOff"
  | "pairingCode"
  | "revoke"
  | "pair"
  | "machinePair"
  | "machineCheck"
  | "machineForget";

const LOCKED: Partial<Record<RemoteAction, string>> = {
  placement:
    "An environment variable (DDL_AGENT_PLACEMENT) sets where the agent runs on this device, so it can't be changed here.",
  remoteHosts:
    "An environment variable (DDL_REMOTE_HOSTS) sets the names this daemon answers to, so they can't be changed here.",
  sync: "Environment variables (DDL_SYNC_URL, DDL_SYNC_VAULT, DDL_SYNC_TOKEN) set this device's sync, so it can't be changed here.",
  syncOff:
    "Environment variables (DDL_SYNC_URL, DDL_SYNC_VAULT, DDL_SYNC_TOKEN) set this device's sync, so it can't be turned off here.",
};

const RATE_LIMITED: Partial<Record<RemoteAction, string>> = {
  pair: "Too many pairing attempts.",
  machinePair: "The always-on machine refused more attempts for now.",
};

/** When to try again after a 429: "Try again in 40 seconds." (a minute without Retry-After). */
function tryAgain(seconds: number | undefined): string {
  if (seconds === undefined) return "Wait a minute, then try again.";
  if (seconds < 60) return `Try again in ${seconds === 1 ? "a second" : `${seconds} seconds`}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in ${minutes === 1 ? "a minute" : `${minutes} minutes`}.`;
}

/**
 * A daemon message as a sentence: zod's validation report (`✖ reason\n  → at field`) becomes its
 * reasons, and it ends with a period.
 */
export function cleanMessage(message: string): string {
  const reasons = message
    .split("\n")
    .filter((line) => line.trim().startsWith("✖"))
    .map((line) => line.replace(/^\s*✖\s*/, "").trim());
  const text = (reasons.length > 0 ? reasons.join("; ") : message).trim();
  if (!text) return "";
  // A leading host name or path keeps its case.
  const firstWord = text.split(/\s/, 1)[0] ?? "";
  const sentence = /[.:/]/.test(firstWord) ? text : text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;
}

function bodyField(error: HttpError, field: "error" | "message"): string {
  const body = error.body;
  if (typeof body !== "object" || body === null) return "";
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

/**
 * What to tell the user when a request about this device, pairing or the always-on machine failed:
 * our wording for the codes that need explaining, the daemon's own message where it's specific.
 */
export function remoteErrorMessage(error: unknown, action: RemoteAction): string {
  if (error instanceof NetworkError) {
    return "Couldn't reach Daily Do List. Check that it's running, then try again.";
  }
  if (!(error instanceof HttpError)) {
    return error instanceof Error && error.message
      ? cleanMessage(error.message)
      : "Something went wrong.";
  }
  const daemon = cleanMessage(bodyField(error, "message"));
  switch (bodyField(error, "error")) {
    case "pairing_rejected":
      return action === "machinePair"
        ? "The always-on machine didn't accept that code: it's wrong, expired or already used. Get a new one on the machine."
        : "That code didn't work: it's wrong, expired or already used. Get a new one and try again.";
    case "locked_by_env":
      return LOCKED[action] ?? (daemon || "An environment variable sets this on this device.");
    case "rate_limited": {
      // Too many attempts come with Retry-After; a full device list or waiting codes don't, and
      // the daemon's message says which.
      const retry = error.retryAfterSeconds;
      const what = RATE_LIMITED[action];
      if (what && (retry !== undefined || action === "machinePair" || !daemon)) {
        return `${what} ${tryAgain(retry)}`;
      }
      if (action === "pairingCode" && !daemon) {
        return "Too many pairing codes are waiting. Use one, or wait until they expire.";
      }
      return daemon || `Too many attempts. ${tryAgain(retry)}`;
    }
    case "machine_unreachable":
      return `The always-on machine didn't answer. Check that it's running and that this device is on your private network (for example Tailscale).${daemon ? ` ${daemon}` : ""}`;
    case "agent_unavailable":
      return daemon || "The agent can't act right now.";
    case "unauthorized":
      return action === "pair"
        ? "Daily Do List refused this browser. Get a new code and try again."
        : "This device isn't allowed in anymore. Pair it again.";
    case "forbidden_host":
      // A proxy in front of a loopback daemon is told how to fix it: pass that on.
      return `Daily Do List refused this page's address.${daemon ? ` ${daemon}` : ""}`;
    case "forbidden_origin":
      return "Daily Do List refused this page's address. Open it at one of its remote hosts.";
    case "payload_too_large":
      return "That's too long.";
    default:
      break;
  }
  if (error.status === 404) {
    if (action === "revoke") return "That device isn't paired anymore.";
    return "This version of Daily Do List can't do that yet. Update it, then try again.";
  }
  if (error.status === 400 && daemon) return daemon;
  if (error.status >= 500) {
    return `Something went wrong in Daily Do List${daemon ? `: ${daemon}` : "."}`;
  }
  return daemon || `The request failed (HTTP ${error.status}).`;
}
