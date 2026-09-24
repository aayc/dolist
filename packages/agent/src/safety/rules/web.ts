/**
 * URL rules shared by browser navigation, web fetches, MCP tools with URL arguments and shell HTTP
 * clients: dangerous schemes, local/private network targets (including this app's own daemon),
 * secrets or personal data in URLs, and GET links that act (unsubscribe, confirm, delete).
 */
import { findCardNumbers, findSecrets, findSsns } from "../sensitive";
import { info, type Match, type RuleHit, runRules, type SafetyRuleInfo } from "./types";

/** The daemon's documented local port; an agent must never drive the app (it could approve itself). */
export const DAEMON_PORT = "7331";

export interface ParsedUrl {
  raw: string;
  scheme: string;
  host: string;
  port: string;
  path: string;
  query: URLSearchParams;
}

/**
 * How browsers read a URL string (WHATWG URL): leading/trailing control characters and spaces are
 * dropped and tabs/newlines are removed everywhere, so `java\tscript:` is `javascript:`.
 */
export function browserUrlForm(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the URL parser strips exactly these.
  return raw.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\t\n\r]/g, "");
}

/** The scheme a reader would see: invisible characters, controls and spaces removed, NFKC applied. */
function visibleScheme(url: string): string | undefined {
  const skeleton = url.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Z}\s]/gu, "");
  return /^([a-z][a-z0-9+.-]*):/i.exec(skeleton)?.[1]?.toLowerCase();
}

export function parseUrl(raw: string): ParsedUrl | undefined {
  const trimmed = browserUrlForm(raw);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (!scheme) return undefined;
  try {
    const url = new URL(trimmed);
    return {
      raw: trimmed,
      scheme,
      // `localhost.` is `localhost`: a trailing dot only marks the name as fully qualified.
      host: url.hostname
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
        .replace(/\.+$/, ""),
      port: url.port,
      path: url.pathname,
      query: url.searchParams,
    };
  } catch {
    return { raw: trimmed, scheme, host: "", port: "", path: "", query: new URLSearchParams() };
  }
}

/** Schemes written without `//`; any other `name:` prefix may be a bare `host:port`. */
const OPAQUE_SCHEMES: ReadonlySet<string> = new Set([
  "javascript",
  "vbscript",
  "file",
  "data",
  "blob",
  "about",
  "filesystem",
  "intent",
  "view-source",
  "chrome",
  "edge",
  "mailto",
  "sms",
  "smsto",
  "mms",
  "tel",
  "callto",
  "facetime",
  "facetime-audio",
  "imessage",
  "whatsapp",
  "skype",
  "zoommtg",
  "msteams",
  "tg",
  "http",
  "https",
]);

/**
 * A URL argument as browser and HTTP tools open it: bare hosts such as `example.com`,
 * `127.0.0.1:7331/x` or `localhost:7331` get `http://`, like the browser executor and curl do.
 */
export function asWebUrl(raw: string): string {
  const url = browserUrlForm(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  if (url.startsWith(":")) return `http://localhost${url}`;
  const prefix = /^([a-z][a-z0-9+.-]*):(.?)/i.exec(url);
  if (prefix && (OPAQUE_SCHEMES.has(prefix[1]!.toLowerCase()) || !/\d/.test(prefix[2]!)))
    return url;
  return `http://${url}`;
}

function ipv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m ? m.slice(1).map(Number) : undefined;
}

function isPrivateIpv4(parts: number[]): boolean {
  const [a = -1, b = -1] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Public DNS names that resolve to 127.0.0.1 (for any subdomain). */
const LOOPBACK_DOMAINS_RE = /(?:^|\.)(?:localtest\.me|lvh\.me|vcap\.me|localho\.st)$/;

/** The IPv4 address spelled inside a wildcard-DNS name (`127.0.0.1.nip.io`, `10-0-0-1.sslip.io`). */
function wildcardDnsIpv4(host: string): number[] | undefined {
  if (!/\.(?:nip\.io|sslip\.io|xip\.io|localtest\.me)$/.test(host)) return undefined;
  const embedded = /(?:^|[.-])((?:\d{1,3}[.-]){3}\d{1,3})(?:[.-]|$)/
    .exec(host)?.[1]
    ?.replace(/-/g, ".");
  return embedded ? ipv4(embedded) : undefined;
}

export function isLoopbackHost(host: string): boolean {
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host === "::" ||
    host === "0.0.0.0" ||
    LOOPBACK_DOMAINS_RE.test(host)
  )
    return true;
  const v4 = ipv4(host) ?? wildcardDnsIpv4(host);
  if (v4) return v4[0] === 127 || v4[0] === 0;
  return /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(host);
}

export function isPrivateHost(host: string): boolean {
  if (!host) return false;
  if (isLoopbackHost(host)) return true;
  const v4 = ipv4(host);
  if (v4) return isPrivateIpv4(v4);
  if (/^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host)) return true;
  if (
    /^::ffff:(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|a[0-9a-f]{2}:|c0a8:)/.test(
      host,
    )
  )
    return true;
  if (
    /\.(?:local|internal|lan|intranet|home\.arpa|localdomain)$/.test(host) ||
    host === "host.docker.internal" ||
    host === "gateway.docker.internal"
  ) {
    return true;
  }
  const parts = wildcardDnsIpv4(host);
  return parts !== undefined && isPrivateIpv4(parts);
}

const METADATA_HOSTS: ReadonlySet<string> = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "100.100.100.200",
  "fd00:ec2::254",
  "169.254.170.2",
]);

const DENIED_SCHEMES: ReadonlySet<string> = new Set([
  "javascript",
  "vbscript",
  "file",
  "chrome",
  "chrome-extension",
  "chrome-untrusted",
  "edge",
  "brave",
  "opera",
  "vivaldi",
  "devtools",
  "view-source",
]);
const MESSAGE_SCHEMES: ReadonlySet<string> = new Set([
  "mailto",
  "sms",
  "smsto",
  "mms",
  "tel",
  "callto",
  "facetime",
  "facetime-audio",
  "imessage",
  "whatsapp",
  "skype",
  "zoommtg",
  "msteams",
  "tg",
]);

function segments(url: ParsedUrl): string[] {
  return url.path
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s)
          .toLowerCase()
          .replace(/\.(?:php|html?|aspx?|jsp|cgi)$/, "");
      } catch {
        return s.toLowerCase();
      }
    });
}

function queryValues(url: ParsedUrl, keys: RegExp): string[] {
  const out: string[] = [];
  for (const [k, v] of url.query) if (keys.test(k)) out.push(v.toLowerCase());
  return out;
}

const TOKENISH_RE = /[A-Za-z0-9_-]{16,}/;

function hasToken(url: ParsedUrl): boolean {
  for (const [k, v] of url.query)
    if (/token|code|key|sig|hash|id|t$/i.test(k) && TOKENISH_RE.test(v)) return true;
  return url.path.split("/").some((s) => TOKENISH_RE.test(s) && /\d/.test(s));
}

const ACTION_PARAM_RE = /^(?:action|do|op|cmd|task|mode)$/i;

interface UrlRule extends SafetyRuleInfo {
  match(url: ParsedUrl): Match;
}

function urlRule(meta: SafetyRuleInfo, match: (url: ParsedUrl) => Match): UrlRule {
  return { ...meta, match };
}

export const URL_RULES: readonly UrlRule[] = [
  urlRule(
    info(
      "browser.dangerous-scheme",
      "system",
      "deny",
      "critical",
      "Opens a script, local-file or browser-internal address",
    ),
    (u) => (DENIED_SCHEMES.has(u.scheme) ? `${u.scheme}: URL` : null),
  ),
  urlRule(
    info(
      "network.app-self-access",
      "system",
      "deny",
      "critical",
      "Operates the Daily Do List app itself (an agent could approve its own actions)",
    ),
    (u) => (isLoopbackHost(u.host) && u.port === DAEMON_PORT ? `${u.host}:${u.port}` : null),
  ),
  urlRule(
    info(
      "communication.message-link",
      "communication",
      "require_approval",
      "high",
      "Opens a link that starts an email, message or call",
    ),
    (u) => (MESSAGE_SCHEMES.has(u.scheme) ? u.raw.slice(0, 80) : null),
  ),
  urlRule(
    info(
      "system.non-web-link",
      "system",
      "require_approval",
      "medium",
      "Opens a non-web address (data:, blob:, app links, …)",
    ),
    (u) => {
      if (
        u.scheme === "http" ||
        u.scheme === "https" ||
        DENIED_SCHEMES.has(u.scheme) ||
        MESSAGE_SCHEMES.has(u.scheme)
      )
        return null;
      if (u.scheme === "about" && /^about:(?:blank|srcdoc)$/i.test(u.raw)) return null;
      return `${u.scheme}: URL`;
    },
  ),
  urlRule(
    info(
      "credentials.cloud-metadata",
      "credentials",
      "require_approval",
      "high",
      "Reads a cloud instance-metadata endpoint (serves live credentials)",
    ),
    (u) => (METADATA_HOSTS.has(u.host) ? u.host : null),
  ),
  urlRule(
    info(
      "network.local-address",
      "network",
      "require_approval",
      "high",
      "Reaches a service on this computer or the local network",
    ),
    (u) => {
      if ((u.port === DAEMON_PORT && isLoopbackHost(u.host)) || METADATA_HOSTS.has(u.host))
        return null;
      return isPrivateHost(u.host) ? `${u.host}${u.port ? `:${u.port}` : ""}` : null;
    },
  ),
  urlRule(
    info(
      "credentials.secret-in-url",
      "credentials",
      "require_approval",
      "high",
      "Puts a secret or credentials into a URL",
    ),
    (u) => findSecrets(u.raw)[0]?.label ?? null,
  ),
  urlRule(
    info(
      "privacy.personal-data-in-url",
      "privacy",
      "require_approval",
      "high",
      "Puts a card number or ID number into a URL",
    ),
    (u) => {
      const hit = findCardNumbers(u.raw)[0] ?? findSsns(u.raw)[0];
      return hit ? hit.label : null;
    },
  ),
  urlRule(
    info(
      "account.unsubscribe-link",
      "account",
      "require_approval",
      "medium",
      "Opens an unsubscribe / opt-out link",
    ),
    (u) => {
      const segs = segments(u);
      const hit =
        segs.find((s) =>
          /^(?:unsubscribe|opt-?out|optout|email-?preferences\/unsubscribe|list-unsubscribe)$/.test(
            s,
          ),
        ) ?? queryValues(u, ACTION_PARAM_RE).find((v) => /^(?:unsubscribe|opt-?out)$/.test(v));
      return hit ? `/${hit}` : null;
    },
  ),
  urlRule(
    info(
      "destructive.delete-link",
      "destructive",
      "require_approval",
      "medium",
      "Opens a link that deletes or cancels something",
    ),
    (u) => {
      const segs = segments(u);
      const hit =
        segs.find((s) =>
          /^(?:delete|remove|destroy|purge|cancel-(?:subscription|order|booking|reservation|account))$/.test(
            s,
          ),
        ) ??
        queryValues(u, ACTION_PARAM_RE).find((v) => /^(?:delete|remove|destroy|purge)$/.test(v));
      return hit ? `/${hit}` : null;
    },
  ),
  urlRule(
    info(
      "forms.action-link",
      "form_submission",
      "require_approval",
      "medium",
      "Opens a link that confirms, approves or answers something",
    ),
    (u) => {
      const segs = segments(u);
      const magic = segs.find((s) =>
        /^(?:confirm|verify|activate|approve|accept|authorize|magic-?link|login-?link)$/.test(s),
      );
      if (magic && hasToken(u)) return `/${magic}`;
      const invite = segs.find((s) =>
        /^(?:rsvp|respond|accept-?invite|accept-?invitation|decline)$/.test(s),
      );
      if (invite && [...u.query.keys()].length > 0) return `/${invite}`;
      const action = queryValues(u, ACTION_PARAM_RE).find((v) =>
        /^(?:confirm|approve|accept|rsvp|respond|decline|cancel)$/.test(v),
      );
      if (action) return `${[...u.query.keys()].find((k) => ACTION_PARAM_RE.test(k))}=${action}`;
      if (
        u.host === "calendar.google.com" &&
        (u.query.has("rst") || /respond/i.test(u.query.get("action") ?? ""))
      )
        return "calendar RSVP link";
      return null;
    },
  ),
];

export const WEB_READ = info("web.read", "read", "allow", "low", "Reads a public web page");
export const WEB_SEARCH = info("web.search", "read", "allow", "low", "Searches the web");

/** Rule hits for one URL argument; bare hosts are read as http URLs (see `asWebUrl`). */
export function urlHits(raw: string): RuleHit[] {
  const url = parseUrl(asWebUrl(raw));
  if (!url) return [];
  // `\u200Bjavascript:` or full-width letters: judge the scheme a reader would see.
  const hidden = visibleScheme(browserUrlForm(raw));
  const scheme = hidden && DENIED_SCHEMES.has(hidden) ? hidden : url.scheme;
  return runRules(URL_RULES, scheme === url.scheme ? url : { ...url, scheme });
}
