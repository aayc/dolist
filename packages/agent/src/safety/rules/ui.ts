/**
 * Rules for browser and computer-use actions: what a click commits to (purchase, booking,
 * sending, posting, account changes, deletion, form submission), what is typed and where
 * (credentials, card numbers, personal data, secrets), key presses, uploads and page scripts.
 */
import type { ActionFacts } from "../facts";
import { findCardNumbers, findSecrets, findSsns, looksLikeSecret } from "../sensitive";
import {
  ACCOUNT_CONTROL,
  AMOUNT_FIELD,
  BENIGN_CONTROL,
  BOOKING_CHANGE_CONTROL,
  BOOKING_CONTROL,
  CARD_FIELD,
  COMMITTING_INTENT,
  COMMUNICATION_CONTROL,
  CONTACT_FIELD,
  CREDENTIAL_FIELD,
  DESTRUCTIVE_CONTROL,
  FORM_SUBMIT_CONTROL,
  MESSAGE_FIELD,
  NON_POSTAL_ADDRESS,
  PAYMENT_CONTROL,
  PAYMENT_METHOD_CONTROL,
  PERSONAL_FIELD,
  PUBLISHING_CONTROL,
  SEARCH_FIELD,
  SUBSCRIPTION_CONTROL,
  TERMINAL_FIELD,
} from "../vocab";
import {
  CARD_NUMBER_RULE,
  executedTextHits,
  MONEY_TRANSFER_RULE,
  moneyTransferInText,
  SECRET_VALUE_RULE,
  SSN_VALUE_RULE,
} from "./content";
import {
  type ActionRule,
  info,
  type Match,
  quote,
  type RuleHit,
  type SafetyRuleInfo,
} from "./types";

function uiRule(meta: SafetyRuleInfo, match: (f: ActionFacts) => Match): ActionRule {
  return { ...meta, match };
}

function label(f: ActionFacts): string {
  return quote(f.elementLabel || f.element || f.operation);
}

function clicked(re: RegExp) {
  return (f: ActionFacts): Match =>
    f.ui?.action === "click" && f.element && re.test(f.element) ? label(f) : null;
}

function typedInto(test: (element: string) => boolean) {
  return (f: ActionFacts): Match =>
    f.ui?.action === "type" && f.element && test(f.element) ? label(f) : null;
}

const matches = (re: RegExp) => (element: string) => re.test(element);

function isComputerNonRead(f: ActionFacts): boolean {
  return f.ui?.surface === "computer" && !/(?:^|_)screenshot$/.test(f.operation);
}

/** True when typing targets something whose value must never be shown. */
export function isSensitiveField(element: string): boolean {
  return (
    CREDENTIAL_FIELD.test(element) ||
    CARD_FIELD.test(element) ||
    /(?:^| )(?:ssn|social security|passport|tax id)(?= |$)/.test(element)
  );
}

const personalField = (f: ActionFacts): Match => {
  if (f.ui?.action !== "type" || !f.element || !PERSONAL_FIELD.test(f.element)) return null;
  if (
    /(?:^| )address(?= |$)/.test(f.element) &&
    NON_POSTAL_ADDRESS.test(f.element) &&
    !/(?:^| )(?:home|street|mailing|billing|shipping) address/.test(f.element)
  )
    return null;
  return label(f);
};

export const UI_RULES: readonly ActionRule[] = [
  uiRule(
    info(
      "computer_control.desktop-action",
      "computer_control",
      "require_approval",
      "medium",
      "Controls your computer's mouse or keyboard",
    ),
    (f) => (isComputerNonRead(f) ? (f.elementLabel ? label(f) : f.operation) : null),
  ),

  uiRule(
    info(
      "payment.purchase-control",
      "payment",
      "require_approval",
      "high",
      "Completes a purchase or payment",
    ),
    clicked(PAYMENT_CONTROL),
  ),
  uiRule(
    info(
      "payment.subscription-control",
      "payment",
      "require_approval",
      "high",
      "Starts, upgrades or renews a paid subscription",
    ),
    clicked(SUBSCRIPTION_CONTROL),
  ),
  uiRule(
    info(
      "payment.payment-method-control",
      "payment",
      "require_approval",
      "high",
      "Adds or changes a payment method",
    ),
    clicked(PAYMENT_METHOD_CONTROL),
  ),
  uiRule(
    info(
      "booking.reservation-control",
      "booking",
      "require_approval",
      "high",
      "Books, reserves, schedules or RSVPs",
    ),
    clicked(BOOKING_CONTROL),
  ),
  uiRule(
    info(
      "booking.change-control",
      "booking",
      "require_approval",
      "high",
      "Cancels or changes a reservation or appointment",
    ),
    clicked(BOOKING_CHANGE_CONTROL),
  ),
  uiRule(
    info(
      "communication.send-control",
      "communication",
      "require_approval",
      "high",
      "Sends a message, email, reply, invite or comment",
    ),
    clicked(COMMUNICATION_CONTROL),
  ),
  uiRule(
    info(
      "publishing.post-control",
      "publishing",
      "require_approval",
      "high",
      "Posts, publishes, shares, uploads or reacts publicly",
    ),
    clicked(PUBLISHING_CONTROL),
  ),
  uiRule(
    info(
      "account.account-control",
      "account",
      "require_approval",
      "high",
      "Creates, deletes or changes an account, its security or its permissions",
    ),
    clicked(ACCOUNT_CONTROL),
  ),
  uiRule(
    info(
      "destructive.delete-control",
      "destructive",
      "require_approval",
      "high",
      "Deletes, clears or resets something",
    ),
    clicked(DESTRUCTIVE_CONTROL),
  ),
  uiRule(
    info(
      "forms.submit-control",
      "form_submission",
      "require_approval",
      "medium",
      "Submits or confirms a form",
    ),
    clicked(FORM_SUBMIT_CONTROL),
  ),

  uiRule(
    info(
      "credentials.sensitive-field",
      "credentials",
      "require_approval",
      "high",
      "Types into a password, card, security-code or other secret field",
    ),
    typedInto(isSensitiveField),
  ),
  uiRule(
    info(
      "payment.card-field",
      "payment",
      "require_approval",
      "high",
      "Fills in payment card or bank details",
    ),
    typedInto(matches(CARD_FIELD)),
  ),
  uiRule(
    info(
      "payment.amount-field",
      "payment",
      "require_approval",
      "medium",
      "Enters a payment, tip or transfer amount",
    ),
    typedInto(matches(AMOUNT_FIELD)),
  ),
  uiRule(
    info(
      "privacy.personal-field",
      "privacy",
      "require_approval",
      "medium",
      "Shares personal details (ID numbers, date of birth, phone, address)",
    ),
    personalField,
  ),
  uiRule(
    info(
      "communication.message-submit",
      "communication",
      "require_approval",
      "high",
      "Types a message and sends it",
    ),
    (f) => (f.ui?.action === "type" && f.submit && MESSAGE_FIELD.test(f.element) ? label(f) : null),
  ),
  uiRule(
    info(
      "forms.submit-typed",
      "form_submission",
      "require_approval",
      "medium",
      "Types into a form field and submits it",
    ),
    (f) => {
      if (f.ui?.action !== "type" || !f.submit || MESSAGE_FIELD.test(f.element)) return null;
      return SEARCH_FIELD.test(f.element) && !CONTACT_FIELD.test(f.element) ? null : label(f);
    },
  ),

  uiRule(
    info(
      "communication.send-shortcut",
      "communication",
      "require_approval",
      "high",
      "Presses a send shortcut (Cmd/Ctrl+Enter)",
    ),
    (f) => (f.key && /^(?:cmd|ctrl)\+(?:shift\+)?enter$/.test(f.key) ? f.key : null),
  ),
  uiRule(
    info(
      "destructive.delete-shortcut",
      "destructive",
      "require_approval",
      "high",
      "Presses a delete / empty-trash shortcut",
    ),
    (f) =>
      f.ui?.surface === "computer" &&
      f.key &&
      /^(?:cmd|ctrl)\+(?:(?:shift|alt)\+)*(?:backspace|delete)$/.test(f.key)
        ? f.key
        : null,
  ),
  uiRule(
    info(
      "system.system-shortcut",
      "system",
      "require_approval",
      "medium",
      "Quits apps, force-quits or logs out",
    ),
    (f) =>
      f.ui?.surface === "computer" &&
      f.key &&
      /^(?:cmd\+q|cmd\+alt\+escape|alt\+cmd\+escape|cmd\+shift\+q|cmd\+alt\+shift\+q|ctrl\+alt\+delete|ctrl\+cmd\+q)$/.test(
        f.key,
      )
        ? f.key
        : null,
  ),
  uiRule(
    info(
      "forms.enter-key",
      "form_submission",
      "require_approval",
      "medium",
      "Presses Enter while working on a task that commits something (purchase, booking, message…)",
    ),
    (f) =>
      f.key && /^(?:shift\+)?enter$/.test(f.key) && COMMITTING_INTENT.test(f.intent)
        ? "Enter"
        : null,
  ),

  uiRule(
    info(
      "privacy.file-upload",
      "privacy",
      "require_approval",
      "high",
      "Uploads files from your computer to a website",
    ),
    (f) => (f.ui?.action === "upload" ? label(f) : null),
  ),
  uiRule(
    info(
      "system.page-script",
      "system",
      "require_approval",
      "high",
      "Runs custom JavaScript in the page (it can do anything you can on that site)",
    ),
    (f) => (f.ui?.action === "script" ? f.operation : null),
  ),
];

/** Allow-rules: interactions recognized as not committing anything. */
export const BENIGN_UI = {
  control: info(
    "browser.benign-control",
    "browser_input",
    "allow",
    "low",
    "Clicks navigation, search, filters, cookie banners or links",
  ),
  typing: info(
    "browser.benign-typing",
    "browser_input",
    "allow",
    "low",
    "Types into a field without submitting (or into a search box)",
  ),
  key: info(
    "browser.benign-key",
    "browser_input",
    "allow",
    "low",
    "Presses a navigation key (Tab, Escape, arrows, paging)",
  ),
  select: info(
    "browser.benign-select",
    "browser_input",
    "allow",
    "low",
    "Chooses an option in a dropdown",
  ),
  read: info(
    "ui.read-only",
    "read",
    "allow",
    "low",
    "Looks at the page or screen, scrolls, hovers or goes back",
  ),
} as const;

export function benignUiHit(f: ActionFacts): RuleHit | undefined {
  const action = f.ui?.action;
  if (!action || f.ui?.surface !== "browser") {
    return f.ui?.surface === "computer" && /(?:^|_)screenshot$/.test(f.operation)
      ? { rule: BENIGN_UI.read, evidence: f.operation }
      : undefined;
  }
  switch (action) {
    case "click":
      return f.element && BENIGN_CONTROL.test(f.element)
        ? { rule: BENIGN_UI.control, evidence: label(f) }
        : undefined;
    case "type":
      return !f.submit || SEARCH_FIELD.test(f.element)
        ? { rule: BENIGN_UI.typing, evidence: label(f) }
        : undefined;
    case "key":
      return f.key &&
        /^(?:(?:shift\+)?tab|escape|up|down|left|right|pageup|pagedown|page_up|page_down|home|end|space)$/.test(
          f.key,
        )
        ? { rule: BENIGN_UI.key, evidence: f.key }
        : undefined;
    case "select":
      return { rule: BENIGN_UI.select, evidence: label(f) };
    case "hover":
    case "read":
      return { rule: BENIGN_UI.read, evidence: f.operation };
    case "dialog":
      return f.input.accept === false
        ? { rule: BENIGN_UI.read, evidence: "dismiss dialog" }
        : undefined;
    default:
      return undefined;
  }
}

/** Rules on typed values: cards, secrets, SSNs, money transfers, and shell commands typed into terminals. */
export function typedTextHits(f: ActionFacts): RuleHit[] {
  const text = f.typedText;
  if (text === undefined || text === "") return [];
  const hits: RuleHit[] = [];
  if (findCardNumbers(text).length > 0)
    hits.push({ rule: CARD_NUMBER_RULE, evidence: "card number (hidden)" });
  const secret = findSecrets(text)[0];
  if (secret || (looksLikeSecret(text) && !SEARCH_FIELD.test(f.element))) {
    hits.push({
      rule: SECRET_VALUE_RULE,
      evidence: `${secret?.label ?? "secret-looking value"} (hidden)`,
    });
  }
  if (findSsns(text).length > 0) hits.push({ rule: SSN_VALUE_RULE, evidence: "SSN (hidden)" });
  const transfer = moneyTransferInText(text);
  if (transfer) hits.push({ rule: MONEY_TRANSFER_RULE, evidence: quote(transfer) });
  const terminal = f.ui?.surface === "computer" || TERMINAL_FIELD.test(f.element);
  if (terminal) hits.push(...executedTextHits(text, "typed text"));
  return hits;
}
