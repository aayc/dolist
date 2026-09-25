// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, NetworkError } from "../../api/errors";
import type { PairBrowser } from "../../api/pairing";
import { defaultBrowserName } from "./browser-name";
import { PairingScreen } from "./PairingScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement;

function render(pair: PairBrowser, options: { revoked?: boolean } = {}) {
  const onPaired = vi.fn();
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => {
    root!.render(
      <PairingScreen
        pair={pair}
        onPaired={onPaired}
        revoked={options.revoked ?? false}
        defaultName="Chrome on macOS"
      />,
    );
  });
  return { onPaired };
}

const q = <T extends Element = HTMLElement>(testId: string) =>
  container.querySelector<T>(`[data-testid="${testId}"]`);

/** Sets a controlled input's value the way typing does (React tracks the native setter). */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    q<HTMLFormElement>("pairing-screen")!
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe("the pairing screen", () => {
  it("formats the code as XXXX-XXXX and names the browser by default", () => {
    render(vi.fn());
    const code = q<HTMLInputElement>("pairing-code-input")!;
    type(code, "abcd efgh");
    expect(code.value).toBe("ABCD-EFGH");
    expect(q<HTMLInputElement>("pairing-name")!.value).toBe("Chrome on macOS");
  });

  it("pairs with the code and name, then opens the app", async () => {
    const pair = vi.fn<PairBrowser>(async () => ({
      device: {
        id: "pdv_1",
        name: "Chrome on macOS",
        kind: "browser",
        createdAt: 1,
        lastSeenAt: 1,
      },
    }));
    const { onPaired } = render(pair);
    type(q<HTMLInputElement>("pairing-code-input")!, "abcd-efgh");
    type(q<HTMLInputElement>("pairing-name")!, "  Work Chrome ");
    await submit();
    expect(pair).toHaveBeenCalledWith({ code: "ABCDEFGH", name: "Work Chrome" });
    expect(onPaired).toHaveBeenCalledTimes(1);
    expect(q("pairing-done")?.textContent).toBe("Paired. Opening Daily Do List…");
  });

  it("says what's wrong before sending an incomplete code or no name", async () => {
    const pair = vi.fn<PairBrowser>();
    render(pair);
    type(q<HTMLInputElement>("pairing-code-input")!, "ABCD-EF");
    type(q<HTMLInputElement>("pairing-name")!, " ");
    await submit();
    expect(pair).not.toHaveBeenCalled();
    expect(q("pairing-code-problem")?.textContent).toBe("Enter all 8 characters.");
    expect(container.textContent).toContain("Enter a name.");
  });

  it.each([
    [
      new HttpError(401, "Wrong", { error: "pairing_rejected", message: "Wrong" }),
      "That code didn't work: it's wrong, expired or already used. Get a new one and try again.",
    ],
    [
      new HttpError(429, "Too many", { error: "rate_limited", message: "Too many" }),
      "Too many pairing attempts. Wait a minute, then try again.",
    ],
    [
      new NetworkError("fetch failed"),
      "Couldn't reach Daily Do List. Check that it's running, then try again.",
    ],
  ])("explains a refusal and lets the user try again (%s)", async (error, message) => {
    const pair = vi.fn<PairBrowser>(async () => {
      throw error;
    });
    const { onPaired } = render(pair);
    type(q<HTMLInputElement>("pairing-code-input")!, "ABCDEFGH");
    await submit();
    expect(q("pairing-error")?.textContent).toBe(message);
    expect(onPaired).not.toHaveBeenCalled();
    expect(q<HTMLButtonElement>("pairing-submit")!.disabled).toBe(false);
  });

  it("says when this browser was revoked", () => {
    render(vi.fn(), { revoked: true });
    expect(container.querySelector("h1")?.textContent).toBe("This browser was signed out");
  });
});

describe("the browser's default name", () => {
  it.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      false,
      "Chrome on macOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
      false,
      "Safari on macOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
      true,
      "Safari on iPad",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1",
      true,
      "Chrome on iPhone",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      false,
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0",
      false,
      "Firefox on Linux",
    ],
    [
      "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
      true,
      "Chrome on Android",
    ],
    ["curl/8.0", false, "Browser"],
  ])("%s", (userAgent, touch, name) => {
    expect(defaultBrowserName(userAgent, touch)).toBe(name);
  });
});
