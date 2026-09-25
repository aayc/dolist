import type { ActionCategory, ArtifactKind, CitedSource, RiskLevel, SurfaceKind } from "@ddl/core";
import type { BrowserPage, DesktopScene } from "./mock-frames";

/** Same trigger the spec gives the simulated safety gate: these verbs need approval. */
export const RISKY_TASK_RE = /\b(buy|order|book|reserve|email|send|pay)\b/i;

export type ScriptKind = "research" | "purchase" | "booking" | "message" | "computer";

export interface ScriptStep {
  toolName: string;
  label: string;
  input: unknown;
  resultPreview: string;
  durationMs: number;
  surface?: SurfaceKind;
  page?: BrowserPage;
  desktop?: DesktopScene;
  action?: { kind: string; text?: string };
}

export interface ScriptArtifact {
  title: string;
  kind: ArtifactKind;
  mimeType: string;
  language?: string;
  content: string;
}

export interface RiskyAction {
  toolName: string;
  toolLabel: string;
  input: unknown;
  summary: string;
  risk: RiskLevel;
  categories: ActionCategory[];
  reason: string;
  page?: BrowserPage;
  approvedText: string;
  approvedSummary: string;
  deniedText: string;
  deniedSummary: string;
}

export interface TaskScript {
  kind: ScriptKind;
  subagent: string;
  workingSummary: string;
  intro: string;
  steps: ScriptStep[];
  artifact?: ScriptArtifact;
  risky?: RiskyAction;
  finalText: string;
  /** The pages `finalText` cites, as the thread's `sources`. */
  sources?: CitedSource[];
  doneSummary: string;
}

export function classifyTask(text: string): ScriptKind {
  const risky = RISKY_TASK_RE.exec(text)?.[1]?.toLowerCase();
  if (risky === "buy" || risky === "order" || risky === "pay") return "purchase";
  if (risky === "book" || risky === "reserve") return "booking";
  if (risky === "email" || risky === "send") return "message";
  if (/\b(desktop|screenshots?|downloads|folders?|files|finder)\b/i.test(text)) return "computer";
  return "research";
}

function topicOf(text: string): string {
  const clean = text
    .replace(/\[\[|]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 70 ? `${clean.slice(0, 69)}…` : clean;
}

function slug(text: string): string {
  return encodeURIComponent(text.toLowerCase().slice(0, 40));
}

function researchScript(topic: string): TaskScript {
  const results: BrowserPage["items"] = [
    {
      title: "Option A — the all-rounder",
      meta: "4.7 ★ · 1.2k reviews · great value",
      price: "$129",
    },
    {
      title: "Option B — premium pick",
      meta: "4.8 ★ · 640 reviews · best build quality",
      price: "$189",
    },
    {
      title: "Option C — budget choice",
      meta: "4.4 ★ · 2.3k reviews · simple and reliable",
      price: "$79",
    },
  ];
  const page: BrowserPage = {
    url: `https://guide.example/search?q=${slug(topic)}`,
    title: `${topic} — Guide`,
    site: "guide.example",
    query: topic,
    items: results,
  };
  const reviews = `https://reviews.example/${slug(topic)}`;
  return {
    kind: "research",
    subagent: "research",
    workingSummary: "Researching…",
    intro: `On it. I'll research **${topic}**, compare the strongest options and write up a short summary.`,
    steps: [
      {
        toolName: "web_search",
        label: "Web search",
        input: { query: topic, maxResults: 8 },
        resultPreview: "8 results · 3 look relevant",
        durationMs: 800,
      },
      {
        toolName: "browser_navigate",
        label: "Open page",
        input: { url: page.url },
        resultPreview: "Loaded guide.example (200)",
        durationMs: 1300,
        surface: "browser",
        page: { ...page, focus: -1 },
        action: { kind: "navigate" },
      },
      {
        toolName: "browser_extract_text",
        label: "Read page",
        input: { maxChars: 4000 },
        resultPreview: "Extracted 3 candidate options with prices and ratings",
        durationMs: 1000,
        surface: "browser",
        page: { ...page, focus: 0 },
        action: { kind: "scroll" },
      },
    ],
    artifact: {
      title: `Comparison — ${topic}`,
      kind: "markdown",
      mimeType: "text/markdown",
      content: [
        `# ${topic}`,
        "",
        "| Option | Price | Rating | Why pick it |",
        "| --- | --- | --- | --- |",
        "| **A — all-rounder** | $129 | 4.7 ★ | Best balance of price and quality |",
        "| B — premium | $189 | 4.8 ★ | Sturdiest build, longest warranty |",
        "| C — budget | $79 | 4.4 ★ | Cheapest option that still reviews well |",
        "",
        "## Recommendation",
        "Go with **Option A** unless build quality matters more than price.",
        "",
        "_Sources: guide.example, reviews.example (synthetic demo data)._",
      ].join("\n"),
    },
    finalText: `Done! I compared three options for **${topic}**:\n\n- **Option A** ($129) — best overall value [1](${page.url})\n- **Option B** ($189) — premium build [2](${reviews})\n- **Option C** ($79) — budget pick [1](${page.url})\n\nThe full comparison is in the artifact.`,
    sources: [
      {
        url: page.url,
        title: page.title,
        snippet:
          "Three picks compared on price and ratings: Option A $129 (4.7 ★), Option B $189 (4.8 ★), Option C $79 (4.4 ★).",
      },
      {
        url: reviews,
        title: `${topic} — Reviews`,
        snippet: "Owners rate Option B's build quality highest; Option A is the best value.",
      },
    ],
    doneSummary: "3 options",
  };
}

function purchaseScript(topic: string): TaskScript {
  const page: BrowserPage = {
    url: `https://shop.example/p/${slug(topic)}`,
    title: `${topic} — Shop`,
    site: "shop.example",
    query: topic,
    items: [
      { title: topic, meta: "In stock · ships tomorrow · free returns", price: "$24.99" },
      { title: "Gift wrap", meta: "Optional add-on", price: "$3.00" },
    ],
    button: "Place order",
  };
  return {
    kind: "purchase",
    subagent: "shopper",
    workingSummary: "Shopping…",
    intro: `I'll find a good match for **${topic}** and get it ready to order. I'll ask before anything is paid for.`,
    steps: [
      {
        toolName: "web_search",
        label: "Web search",
        input: { query: topic },
        resultPreview: "Best match on shop.example ($24.99, 4.6 ★)",
        durationMs: 800,
      },
      {
        toolName: "browser_navigate",
        label: "Open page",
        input: { url: page.url },
        resultPreview: "Loaded product page",
        durationMs: 1100,
        surface: "browser",
        page: { ...page, focus: 0 },
        action: { kind: "navigate" },
      },
      {
        toolName: "browser_click",
        label: "Click in browser",
        input: { element: "Add to cart button", ref: "e31" },
        resultPreview: "Added to cart — subtotal $24.99",
        durationMs: 900,
        surface: "browser",
        page: { ...page, focus: 0 },
        action: { kind: "click" },
      },
    ],
    artifact: {
      title: "Order summary",
      kind: "json",
      mimeType: "application/json",
      content: JSON.stringify(
        {
          item: topic,
          merchant: "shop.example",
          price: 24.99,
          shipping: 0,
          total: 24.99,
          delivery: "2 days",
        },
        null,
        2,
      ),
    },
    risky: {
      toolName: "browser_click",
      toolLabel: "Click in browser",
      input: { element: "Place order button", ref: "e57" },
      summary: `Place order for “${topic}” — $24.99 with the saved card`,
      risk: "high",
      categories: ["payment", "form_submission"],
      reason: "This spends money on your behalf.",
      page: { ...page, focusButton: true },
      approvedText: "Order placed ✅ Confirmation **#DDL-4821**, arriving in 2 days.",
      approvedSummary: "Ordered · arrives in 2 days",
      deniedText:
        "Okay — I did **not** place the order. The item is still in the cart if you want to finish it yourself.",
      deniedSummary: "Not ordered",
    },
    finalText: "",
    doneSummary: "",
  };
}

function bookingScript(topic: string): TaskScript {
  const page: BrowserPage = {
    url: `https://booking.example/availability?q=${slug(topic)}`,
    title: "Availability — booking.example",
    site: "booking.example",
    query: topic,
    items: [
      { title: "Tue 9:30 AM", meta: "Available · 45 min" },
      { title: "Wed 1:00 PM", meta: "Available · 45 min" },
      { title: "Thu 4:15 PM", meta: "Waitlist" },
    ],
    button: "Confirm booking",
  };
  return {
    kind: "booking",
    subagent: "booker",
    workingSummary: "Checking availability…",
    intro: `Looking for availability for **${topic}**. I'll pick the earliest good slot and check with you before confirming.`,
    steps: [
      {
        toolName: "browser_navigate",
        label: "Open page",
        input: { url: page.url },
        resultPreview: "3 open slots this week",
        durationMs: 1200,
        surface: "browser",
        page: { ...page, focus: -1 },
        action: { kind: "navigate" },
      },
      {
        toolName: "browser_select_option",
        label: "Select option",
        input: { element: "Time slot", values: ["Tue 9:30 AM"] },
        resultPreview: "Selected Tue 9:30 AM",
        durationMs: 900,
        surface: "browser",
        page: { ...page, focus: 0 },
        action: { kind: "click" },
      },
    ],
    risky: {
      toolName: "browser_click",
      toolLabel: "Click in browser",
      input: { element: "Confirm booking button", ref: "e12" },
      summary: `Book “${topic}” for Tue 9:30 AM`,
      risk: "medium",
      categories: ["booking", "form_submission"],
      reason: "This makes a reservation in your name.",
      page: { ...page, focus: 0, focusButton: true },
      approvedText: "Booked for **Tue 9:30 AM** ✅ A confirmation was sent to your inbox.",
      approvedSummary: "Booked · Tue 9:30 AM",
      deniedText: "No problem — nothing was booked. Tue 9:30 AM was the earliest open slot.",
      deniedSummary: "Not booked",
    },
    finalText: "",
    doneSummary: "",
  };
}

function messageScript(topic: string): TaskScript {
  const body = `Hi Alex,\n\nQuick update on “${topic}”: everything is on track and I'll share details by Friday.\n\nThanks!`;
  return {
    kind: "message",
    subagent: "writer",
    workingSummary: "Drafting…",
    intro: `I'll draft a message for **${topic}** using your notes, then check with you before sending.`,
    steps: [
      {
        toolName: "search_notes",
        label: "Search notes",
        input: { query: topic, limit: 5 },
        resultPreview: "2 related notes",
        durationMs: 700,
      },
      {
        toolName: "create_artifact",
        label: "Create artifact",
        input: { title: "Draft email", kind: "markdown" },
        resultPreview: "Draft ready (74 words)",
        durationMs: 700,
      },
    ],
    artifact: {
      title: "Draft email",
      kind: "markdown",
      mimeType: "text/markdown",
      content: `**To:** alex@example.com\n**Subject:** Quick update\n\n${body}`,
    },
    risky: {
      toolName: "mcp__mail__send_message",
      toolLabel: "Send email",
      input: { to: "alex@example.com", subject: "Quick update", body },
      summary: "Send email to alex@example.com — “Quick update”",
      risk: "medium",
      categories: ["communication"],
      reason: "This sends a message to another person on your behalf.",
      approvedText: "Sent ✅ The email to **alex@example.com** is on its way.",
      approvedSummary: "Sent",
      deniedText:
        "Understood — I didn't send it. The draft is saved as an artifact if you want to reuse it.",
      deniedSummary: "Draft ready · not sent",
    },
    finalText: "",
    doneSummary: "",
  };
}

function computerScript(topic: string): TaskScript {
  const files = [
    "Invoice-0142.pdf",
    "Screenshot 09-21.png",
    "Screenshot 09-22.png",
    "notes-draft.txt",
    "setup-installer.dmg",
    "Trip itinerary.pdf",
  ];
  return {
    kind: "computer",
    subagent: "operator",
    workingSummary: "Working on your Mac…",
    intro: `I'll take care of **${topic}** using the computer-use tools. You can watch in the Computer tab.`,
    steps: [
      {
        toolName: "computer_screenshot",
        label: "Screenshot",
        input: {},
        resultPreview: "Captured 960×600",
        durationMs: 700,
        surface: "computer",
        desktop: { app: "Finder", files },
        action: { kind: "screenshot" },
      },
      {
        toolName: "computer_click",
        label: "Click",
        input: { x: 520, y: 193, element: "Screenshot 09-21.png" },
        resultPreview: "Selected Screenshot 09-21.png",
        durationMs: 900,
        surface: "computer",
        desktop: { app: "Finder", files, selected: 1 },
        action: { kind: "click" },
      },
      {
        toolName: "computer_key",
        label: "Key press",
        input: { combo: "cmd+shift+n" },
        resultPreview: "Created folder “Screenshots”",
        durationMs: 900,
        surface: "computer",
        desktop: {
          app: "Finder",
          files: ["Screenshots", ...files.filter((f) => !f.startsWith("Screenshot"))],
          selected: 0,
        },
        action: { kind: "key", text: "⌘⇧N" },
      },
    ],
    finalText: `Finished **${topic}**: screenshots are now grouped in a “Screenshots” folder and the rest of Downloads is untouched.\n\nTo put them back:\n\n\`\`\`sh\nmv ~/Downloads/Screenshots/* ~/Downloads/\n\`\`\``,
    doneSummary: "Organized 6 files",
  };
}

export function buildScript(taskText: string): TaskScript {
  const topic = topicOf(taskText);
  switch (classifyTask(taskText)) {
    case "purchase":
      return purchaseScript(topic);
    case "booking":
      return bookingScript(topic);
    case "message":
      return messageScript(topic);
    case "computer":
      return computerScript(topic);
    default:
      return researchScript(topic);
  }
}
