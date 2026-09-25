/**
 * Apps the rules know by name. Patterns run on `normalizePhrase` output (lowercase words; dots of
 * bundle ids become spaces; camelCase adds a split reading), so both the model's `app` text and a
 * tool's real app name (`ToolSubject.app`) match, however they are spelled.
 *
 * - Protected apps are never operated by agents: the Daily Do List app itself (an agent could
 *   approve its own actions), System Settings (it could grant itself permissions), password
 *   managers, keychains, authenticators and the system's login and security prompts. The
 *   `ddl-computer` helper refuses the same apps by bundle id and process tree, whatever they are
 *   called; this list lets the rules deny calls before they reach it, and screen-level clicks too.
 * - Messaging apps are where Return, a typed line break or a send-like control sends a message to
 *   someone.
 */
import { normalizePhrase } from "./vocab";

function words(...alternatives: string[]): RegExp {
  return new RegExp(`(?:^| )(?:${alternatives.join("|")})(?= |$)`);
}

/** A whole normalized name (either reading), for app names that are also common words. */
function whole(...alternatives: string[]): RegExp {
  return new RegExp(`(?:^|\\n )(?:${alternatives.join("|")})(?: app)?(?: \\n|$)`);
}

interface NamedPattern {
  /** How the rules name it in reasons. */
  name: string;
  /** Matches the app's name or bundle id. */
  app: RegExp;
  /** Matches distinctive names in any text (element labels of screen-level clicks). */
  anywhere?: RegExp;
}

const PROTECTED_APPS: readonly NamedPattern[] = [
  {
    name: "Daily Do List",
    app: words("daily ?do ?list", "app dailydolist(?: [a-z0-9]+)*"),
    anywhere: words("daily ?do ?list"),
  },
  {
    name: "System Settings",
    app: words("system (?:settings|preferences)", "com apple (?:systempreferences|settings)"),
    anywhere: words("system (?:settings|preferences)"),
  },
  {
    name: "Keychain Access",
    app: words("keychain(?: access)?", "com apple keychainaccess"),
    anywhere: words("keychain access"),
  },
  { name: "Passwords", app: whole("passwords", "apple passwords", "com apple passwords") },
  {
    name: "1Password",
    app: words("1 ?password(?: \\d+)?", "com 1password(?: [a-z0-9]+)*", "agilebits(?: [a-z0-9]+)*"),
    anywhere: words("1password"),
  },
  { name: "Bitwarden", app: words("bitwarden"), anywhere: words("bitwarden") },
  { name: "Dashlane", app: words("dashlane"), anywhere: words("dashlane") },
  { name: "LastPass", app: words("last ?pass"), anywhere: words("lastpass") },
  { name: "KeePassXC", app: words("kee ?pass(?: ?xc)?"), anywhere: words("keepassxc?") },
  { name: "Okta Verify", app: words("okta(?: verify)?"), anywhere: words("okta verify") },
  {
    name: "Yubico Authenticator",
    app: words("yubico(?: authenticator)?", "yubikey(?: manager)?"),
    anywhere: words("yubico authenticator"),
  },
  { name: "an authenticator app", app: words("authenticator", "authy") },
  {
    name: "the macOS login and security prompts",
    app: words(
      "security ?agent",
      "com apple securityagent",
      "login ?window",
      "com apple loginwindow",
    ),
  },
];

const MESSAGING_APPS: readonly NamedPattern[] = [
  { name: "Slack", app: words("slack", "com tinyspeck slackmacgap") },
  {
    name: "Messages",
    app: whole("messages", "imessage", "com apple (?:messages|ichat|mobilesms)"),
  },
  { name: "Mail", app: whole("mail", "apple mail", "com apple mail") },
  { name: "WhatsApp", app: words("whats ?app(?: messenger)?") },
  { name: "Telegram", app: words("telegram(?: desktop)?") },
  { name: "Discord", app: words("discord") },
  { name: "Signal", app: whole("signal", "org whispersystems signal(?: desktop)?") },
  { name: "Microsoft Teams", app: words("microsoft teams", "teams", "com microsoft teams2?") },
  { name: "Outlook", app: words("(?:microsoft )?outlook") },
  { name: "Messenger", app: words("(?:facebook )?messenger") },
  { name: "Zoom", app: words("zoom(?: us)?", "zoom workplace") },
  { name: "Skype", app: words("skype") },
  { name: "Webex", app: words("(?:cisco )?webex") },
  { name: "Beeper", app: words("beeper") },
  { name: "Element", app: whole("element", "im riot app") },
  { name: "WeChat", app: words("wechat") },
  { name: "Viber", app: words("viber") },
  { name: "Spark", app: words("spark(?: mail)?", "readdle spark") },
  { name: "Airmail", app: words("airmail") },
  { name: "Thunderbird", app: words("thunderbird") },
  { name: "Mimestream", app: words("mimestream") },
  { name: "Superhuman", app: words("superhuman") },
];

function find(list: readonly NamedPattern[], names: readonly string[]): string | undefined {
  for (const name of names) {
    const normalized = normalizePhrase(name);
    if (!normalized) continue;
    const hit = list.find((entry) => entry.app.test(normalized));
    if (hit) return hit.name;
  }
  return undefined;
}

/** The protected app one of these names (app names or bundle ids) refers to, if any. */
export function protectedApp(...names: ReadonlyArray<string | undefined>): string | undefined {
  return find(
    PROTECTED_APPS,
    names.filter((n): n is string => !!n),
  );
}

/** A protected app named anywhere in a normalized text (distinctive names only). */
export function protectedAppMentioned(normalized: string): string | undefined {
  return PROTECTED_APPS.find((entry) => entry.anywhere?.test(normalized))?.name;
}

/** The messaging app one of these names refers to, if any. */
export function messagingApp(...names: ReadonlyArray<string | undefined>): string | undefined {
  return find(
    MESSAGING_APPS,
    names.filter((n): n is string => !!n),
  );
}
