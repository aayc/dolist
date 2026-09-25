import { copyText } from "../../lib/clipboard";

const SVG = "http://www.w3.org/2000/svg";
const COPIED_MS = 1500;

/** Lucide's `copy` and `check`, drawn here because these buttons live outside React. */
const ICONS = {
  copy: [
    ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }],
    ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }],
  ],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
} as const;

function icon(doc: Document, name: keyof typeof ICONS): SVGSVGElement {
  const svg = doc.createElementNS(SVG, "svg");
  for (const [key, value] of Object.entries({
    width: "14",
    height: "14",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.75",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(key, value);
  }
  for (const [tag, attributes] of ICONS[name]) {
    const shape = svg.appendChild(doc.createElementNS(SVG, tag));
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
  }
  return svg;
}

function label(button: HTMLButtonElement, text: string): void {
  button.setAttribute("aria-label", text);
  button.dataset.tooltip = text;
}

/**
 * Gives each code block in rendered agent markdown a copy button (the sanitizer strips buttons from
 * the markdown itself, so any `.code-copy` is ours).
 */
export function decorateCodeBlocks(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.parentElement?.classList.contains("code-wrap")) continue;
    const wrap = doc.createElement("div");
    wrap.className = "code-wrap";
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "icon-button code-copy";
    button.dataset.testid = "code-copy";
    label(button, "Copy code");
    button.append(icon(doc, "copy"));
    pre.replaceWith(wrap);
    wrap.append(pre, button);
  }
}

/** Copies a code block when its button is clicked, anywhere under `root`. */
export function installCodeCopy(root: HTMLElement): () => void {
  const timers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
  const onClick = async (event: MouseEvent) => {
    const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>(".code-copy");
    const pre = button?.parentElement?.querySelector("pre");
    if (!button || !pre || !root.contains(button)) return;
    if (!(await copyText(pre.textContent ?? ""))) return;
    clearTimeout(timers.get(button));
    button.classList.add("is-copied");
    label(button, "Copied");
    button.replaceChildren(icon(root.ownerDocument, "check"));
    timers.set(
      button,
      setTimeout(() => {
        timers.delete(button);
        button.classList.remove("is-copied");
        label(button, "Copy code");
        button.replaceChildren(icon(root.ownerDocument, "copy"));
      }, COPIED_MS),
    );
  };
  root.addEventListener("click", onClick);
  return () => {
    root.removeEventListener("click", onClick);
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
