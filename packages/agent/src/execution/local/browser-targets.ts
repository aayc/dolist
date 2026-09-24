import type { Locator, Page } from "playwright-core";
import { ElementNotFoundError, StaleRefError } from "../errors";
import type { BrowserTarget } from "../types";
import { normalizeRef } from "./browser-snapshot";

async function firstMatch(locator: Locator): Promise<Locator | undefined> {
  const visible = locator.filter({ visible: true });
  if ((await visible.count()) > 0) return visible.first();
  if ((await locator.count()) > 0) return locator.first();
  return undefined;
}

function quoted(text: string): string {
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text);
}

/**
 * Resolves a model target to a single element: `ref` from the latest snapshot (via Playwright's
 * `aria-ref` engine, which only knows refs from the page's most recent snapshot), else a CSS
 * `selector`, else visible `text`. Fails fast with an actionable message instead of waiting out an
 * action timeout.
 */
export async function resolveTarget(page: Page, target: BrowserTarget): Promise<Locator> {
  if (target.ref?.trim()) {
    const ref = normalizeRef(target.ref);
    if (!ref) {
      throw new StaleRefError(
        `"${target.ref}" is not a valid element ref. Use a ref like "e12" from the latest browser_snapshot.`,
      );
    }
    const locator = page.locator(`aria-ref=${ref}`);
    if ((await locator.count().catch(() => 0)) === 0) {
      throw new StaleRefError(
        `Ref ${ref} is not in the current page snapshot (the page changed since it was taken). Call browser_snapshot and use a ref from the new snapshot.`,
      );
    }
    return locator;
  }
  if (target.selector?.trim()) {
    const match = await firstMatch(page.locator(target.selector));
    if (!match) {
      throw new ElementNotFoundError(
        `No element matches selector ${quoted(target.selector)}. Call browser_snapshot and target the element by ref instead.`,
      );
    }
    return match;
  }
  if (target.text?.trim()) {
    const text = target.text.trim();
    const match =
      (await firstMatch(page.getByText(text, { exact: true }))) ??
      (await firstMatch(page.getByText(text)));
    if (!match) {
      throw new ElementNotFoundError(
        `No element with text ${quoted(text)} is on the page. Call browser_snapshot and target the element by ref instead.`,
      );
    }
    return match;
  }
  throw new ElementNotFoundError(
    "No target given: pass `ref` from the latest browser_snapshot (preferred), or a CSS `selector`, or visible `text`.",
  );
}

/** Center of the element in viewport CSS pixels (for click overlays), if it is laid out. */
export async function elementCenter(
  locator: Locator,
): Promise<{ x: number; y: number } | undefined> {
  const box = await locator.boundingBox({ timeout: 1_000 }).catch(() => null);
  if (!box) return undefined;
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/**
 * Runs in the page: whether a form field holds a secret (password, card number/CVC, one-time code)
 * whose value must never reach the model. Must stay self-contained (serialized into the page).
 */
export const isSensitiveField = (element: Element): boolean => {
  // Tag checks instead of `instanceof`: elements inside iframes belong to another realm.
  const tag = element.localName;
  if (tag !== "input" && tag !== "textarea") return false;
  const field = element as HTMLInputElement;
  if (tag === "input" && field.type === "password") return true;
  const autocomplete = (field.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
  const secretTokens = [
    "current-password",
    "new-password",
    "one-time-code",
    "cc-number",
    "cc-csc",
    "cc-exp",
  ];
  if (autocomplete.some((token) => secretTokens.includes(token))) return true;
  const hints = [
    field.name,
    field.id,
    field.getAttribute("aria-label"),
    field.getAttribute("placeholder"),
  ].join(" ");
  return /pass(?:word|code|phrase)|\bpwd\b|\bcvv\b|\bcvc\b|\bcsc\b|security.?code|card.?(?:number|no)\b|\bcc.?(?:num|number)\b|one.?time|\botp\b|\bpin\b|\bssn\b|social.?security/i.test(
    hints,
  );
};
