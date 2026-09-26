/**
 * The demo vault (synthetic content only: no real people, places or accounts), written as plain
 * files: notes, a drawing, past daily notes, and the agent's sidecar state for yesterday's note,
 * which shows the agent at work in a note (an agent-written sub-bullet citing a source under a
 * task, an agent-written follow-up task, and a question with a thread anchored to its line).
 * Today's note is the empty template, ready for a task. Used by the e2e harness and by `DDL_DEMO=1`
 * (`pnpm dev:mock`, the Mac app's `--demo`).
 */
import { existsSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  encodePersistedJournalEvent,
  encodePersistedRecords,
  PERSISTED_PATHS,
  type PersistedThread,
  persistedThreadImportEvent,
  persistedThreadJournalPath,
} from "@ddl/contract";
import {
  addDays,
  type CitedSource,
  DEFAULT_DAILY_NOTE_CONTENT,
  DEFAULT_SETTINGS,
  type DrawingBoundElement,
  type DrawingElement,
  dailyNotePath,
  emptyDrawingScene,
  serializeDrawingFile,
  type TaskAgentRecord,
  type ThreadMessage,
  today,
  toISODate,
} from "@ddl/core";

const DAY_MS = 86_400_000;
export const DEMO_DINNER_THREAD = "thr_demo_dinner";
export const DEMO_QUESTION_THREAD = "thr_demo_tallest";
const DEMO_QUESTION_ANCHOR = "anc_demo_tallest";
const DEMO_DINNER_TASK_ID = "tsk_demo_dinner";
const DINNER_TASK = "Book a table for Friday dinner";
const QUESTION = "What's the tallest building in NYC?";
const TABLES_URL = "https://tables.example/r/trattoria-sole";
export const DEMO_DRAWING_PATH = "Excalidraw/Garden plan.excalidraw.md";

const LIVING_LIST_LINES = [
  `- [ ] ${DINNER_TASK}`,
  `\t- Trattoria Sole has a table for 2 at 7:00 PM ([Tables](${TABLES_URL})) %%agent:${DEMO_DINNER_THREAD}%%`,
  `- [ ] Call the restaurant to confirm %%agent:${DEMO_DINNER_THREAD}%%`,
  "",
  QUESTION,
];

const PAST_DAYS: Array<{ offset: number; lines: readonly string[] }> = [
  {
    offset: -1,
    lines: [
      "- [x] Compare standing desks under $400",
      "- [x] Order a replacement phone charger",
      "- [ ] Renew library books before Friday",
      "- [x] Draft agenda for Thursday's team sync",
      "  - Include the Q4 roadmap review",
      "- [x] Find a plumber with weekend availability",
      ...LIVING_LIST_LINES,
    ],
  },
  {
    offset: -2,
    lines: [
      "- [x] Research beginner-friendly houseplants for a north-facing window",
      "- [ ] Call the bank about the card replacement",
      "- [x] Summarize the neighborhood newsletter",
    ],
  },
  {
    offset: -4,
    lines: [
      "- [x] Plan a weekend hiking route near the lake",
      "- [ ] Back up the photo library",
      "- [x] Shortlist birthday gift ideas for Alex",
    ],
  },
];

const NOTES: Record<string, string> = {
  "Welcome.md": [
    "# Welcome to Daily Do List",
    "",
    "This is a **demo vault**: the agent is the scripted mock, so nothing leaves your machine.",
    "",
    "- Press **Mod+Shift+D** for today's daily note and write a task, e.g.",
    "  `- [ ] Find three highly rated pizza places nearby`",
    "- Tasks with words like *buy*, *book* or *email* pause for your approval.",
    "- **Mod+Shift+P** jumps to the previous daily note, **Mod+P** opens the command palette.",
    "",
    "See [[Ideas]] and the [[Projects/Garden Redesign|garden project]].",
  ].join("\n"),
  "Ideas.md": [
    "# Ideas",
    "",
    "- A weekly review template that pulls unfinished tasks forward",
    "- Batch errands by neighborhood",
    "- Try a no-meeting Wednesday",
    "",
    "> Small steps every day.",
  ].join("\n"),
  "Projects/Garden Redesign.md": [
    "# Garden Redesign",
    "",
    "Goals for the spring refresh.",
    "",
    "## Beds",
    "- Raised bed along the south fence",
    "- Native pollinator strip",
    "",
    "## Tasks",
    "- [ ] Measure the south fence",
    "- [ ] Get quotes for cedar boards",
  ].join("\n"),
  "Projects/Home Office.md": [
    "# Home Office",
    "",
    "- [x] Pick a desk lamp",
    "- [ ] Cable management tray",
    "- [ ] Acoustic panels for the back wall",
  ].join("\n"),
  "Projects/Reading List.md": [
    "# Reading List",
    "",
    "1. A book about habits",
    "2. A history of maps",
    "3. A field guide to local birds",
  ].join("\n"),
  "Restaurants.md": [
    "# Restaurants",
    "",
    "Places we liked, and what to order.",
    "",
    "- Trattoria Sole — fresh pasta, quiet back room",
    "\t- Fridays fill up: book ahead",
    "- Blue Door Café — weekend brunch",
    "- Noodle Bar on 3rd — quick lunch",
  ].join("\n"),
  "Sketches.md": [
    "# Sketches",
    "",
    "![[Garden plan.excalidraw|300|right-wrap]]",
    "The garden plan is a drawing: double-click it to draw, drag it to move it, or pull its corner",
    "to resize it. The text wraps around it, and it's a plain Excalidraw file that Obsidian opens too.",
    "",
    "- [ ] Measure the south fence",
    "- [ ] Pick plants for the pond edge",
  ].join("\n"),
};

export interface DemoVaultOptions {
  now?: Date;
  /** Extra notes, a third each at the root, in a folder and in a subfolder (performance tests). */
  notes?: number;
}

/** Writes the demo vault into `root` (an empty or missing folder). */
export async function writeDemoVault(root: string, options: DemoVaultOptions = {}): Promise<void> {
  const now = options.now ?? new Date();
  const settings = DEFAULT_SETTINGS.dailyNotes;
  const put = async (path: string, content: string, mtime = now.getTime() - 7 * DAY_MS) => {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    const at = new Date(mtime);
    await utimes(file, at, at);
  };
  await put("Templates/Daily.md", DEFAULT_DAILY_NOTE_CONTENT, now.getTime() - 30 * DAY_MS);
  for (const [path, content] of Object.entries(NOTES)) await put(path, content);
  await put(DEMO_DRAWING_PATH, demoDrawing());
  const current = today(now);
  for (const day of PAST_DAYS) {
    const path = dailyNotePath(addDays(current, day.offset), settings);
    await put(path, day.lines.join("\n"), now.getTime() + day.offset * DAY_MS);
  }
  await put(dailyNotePath(current, settings), DEFAULT_DAILY_NOTE_CONTENT, now.getTime());
  for (let i = 0; i < (options.notes ?? 0); i++) {
    await put(`${["", "Archive/", "Areas/Area 7/"][i % 3]}Note ${i}.md`, `# Note ${i}`);
  }

  // Yesterday is outside the agent's watch window: its records stay as written here.
  const yesterday = addDays(current, -1);
  const notePath = dailyNotePath(yesterday, settings);
  const lines = PAST_DAYS[0]!.lines;
  const doneAt = now.getTime() - DAY_MS;
  const record = (
    fields: Partial<TaskAgentRecord> & Pick<TaskAgentRecord, "taskId" | "text" | "line">,
  ): TaskAgentRecord => ({
    notePath,
    date: toISODate(yesterday),
    status: "done",
    threadId: null,
    updatedAt: doneAt,
    unread: 0,
    ...fields,
  });
  const records = [
    record({
      taskId: DEMO_DINNER_TASK_ID,
      text: DINNER_TASK,
      line: lines.indexOf(`- [ ] ${DINNER_TASK}`),
      summary: "Table for 2 · 7 PM",
      threadId: DEMO_DINNER_THREAD,
    }),
    record({
      taskId: DEMO_QUESTION_ANCHOR,
      text: QUESTION,
      line: lines.indexOf(QUESTION),
      summary: "One World Trade Center",
      threadId: DEMO_QUESTION_THREAD,
      unread: 1,
      anchor: "line",
    }),
  ];
  await put(PERSISTED_PATHS.records, encodePersistedRecords({ records, specs: {} }), doneAt);
  for (const thread of [
    dinnerThread(DEMO_DINNER_TASK_ID, notePath, doneAt),
    questionThread(notePath, doneAt),
  ]) {
    await put(
      persistedThreadJournalPath(thread.id),
      encodePersistedJournalEvent(persistedThreadImportEvent(thread)),
      doneAt,
    );
  }
}

/**
 * `DDL_DEMO=1`, before the daemon starts: seeds DDL_VAULT with the demo vault (tasks settle in
 * 1.2 s) and turns computer use off in DDL_HOME's `config.json`. Both must be absolute paths; a
 * vault folder that already exists opens as it is (a restart) and an existing `config.json` stays,
 * so the demo never writes into your own vault or home.
 */
export async function prepareDemo(env: Record<string, string | undefined>): Promise<void> {
  const home = env.DDL_HOME?.trim() ?? "";
  const vault = env.DDL_VAULT?.trim() ?? "";
  if (!isAbsolute(home) || !isAbsolute(vault)) {
    throw new Error("DDL_DEMO=1 needs absolute DDL_HOME and DDL_VAULT paths");
  }
  if (existsSync(vault)) return;
  await writeDemoVault(vault);
  await writeFile(
    join(vault, ".daily-do-list/settings.json"),
    `${JSON.stringify({ version: 1, agent: { settleMs: 1200 } })}\n`,
  );
  await mkdir(home, { recursive: true, mode: 0o700 });
  const config = { execution: { kind: "local", computer: { enabled: false } } };
  await writeFile(join(home, "config.json"), `${JSON.stringify(config)}\n`, { flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
}

interface DemoThread {
  id: string;
  taskId: string;
  title: string;
  intro: string;
  steps: Array<{ toolName: string; label: string; input: unknown; resultPreview: string }>;
  answer: string;
  sources: CitedSource[];
}

function threadFile(demo: DemoThread, notePath: string, doneAt: number): PersistedThread {
  let clock = doneAt - 60_000;
  const tick = () => {
    clock += 5_000;
    return clock;
  };
  const author = "subagent:research" as const;
  const text = (id: string, body: string): ThreadMessage => ({
    id,
    kind: "text",
    role: "agent",
    author,
    createdAt: tick(),
    text: body,
  });
  const messages: ThreadMessage[] = [
    {
      id: `${demo.id}_start`,
      kind: "status",
      author: "system",
      createdAt: tick(),
      status: "working",
      text: "Started a research subagent",
    },
    text(`${demo.id}_intro`, demo.intro),
  ];
  demo.steps.forEach((step, i) => {
    const at = tick();
    messages.push({
      id: `${demo.id}_step${i}`,
      kind: "tool_call",
      author,
      createdAt: at,
      toolCallId: `${demo.id}_call${i}`,
      toolName: step.toolName,
      label: step.label,
      input: step.input,
      status: "ok",
      resultPreview: step.resultPreview,
      endedAt: at + 1_000,
    });
  });
  messages.push(text(`${demo.id}_answer`, demo.answer), {
    id: `${demo.id}_done`,
    kind: "status",
    author: "system",
    createdAt: tick(),
    status: "done",
  });
  return {
    id: demo.id,
    taskId: demo.taskId,
    notePath,
    title: demo.title,
    status: "done",
    createdAt: doneAt - 60_000,
    updatedAt: doneAt,
    messages,
    artifacts: [],
    surfaces: [],
    sources: demo.sources,
  };
}

function dinnerThread(taskId: string, notePath: string, doneAt: number): PersistedThread {
  return threadFile(
    {
      id: DEMO_DINNER_THREAD,
      taskId,
      title: DINNER_TASK,
      intro:
        "Looking for a table for two on Friday evening, starting with the places in your [[Restaurants]] note.",
      steps: [
        {
          toolName: "web_search",
          label: "Web search",
          input: { query: "Trattoria Sole table for 2 Friday evening" },
          resultPreview: "6 results · 2 look relevant",
        },
        {
          toolName: "web_fetch",
          label: "Read page",
          input: { url: TABLES_URL },
          resultPreview: "Friday: tables for 2 at 6:30 PM and 7:00 PM",
        },
      ],
      answer: [
        `**Trattoria Sole** has a table for 2 at **7:00 PM** on Friday [1](${TABLES_URL}). Reviewers single out the fresh pasta and the quiet back room [2](https://reviews.example/trattoria-sole), and your [[Restaurants]] note says Fridays fill up.`,
        "",
        "I added it under your task, with a follow-up to confirm by phone. Nothing is booked yet.",
      ].join("\n"),
      sources: [
        {
          url: TABLES_URL,
          title: "Trattoria Sole — Book a table",
          snippet:
            "Friday: tables for 2 at 6:30 PM and 7:00 PM. Italian · $$ · 4.7 ★ (1.2k reviews).",
        },
        {
          url: "https://reviews.example/trattoria-sole",
          title: "Trattoria Sole reviews",
          snippet: "“The fresh pasta is the star, and the back room is quiet enough to talk.”",
        },
      ],
    },
    notePath,
    doneAt,
  );
}

function questionThread(notePath: string, doneAt: number): PersistedThread {
  return threadFile(
    {
      id: DEMO_QUESTION_THREAD,
      taskId: DEMO_QUESTION_ANCHOR,
      title: QUESTION,
      intro: "A quick one: I'll look it up.",
      steps: [
        {
          toolName: "web_search",
          label: "Web search",
          input: { query: "tallest building in New York City" },
          resultPreview: "8 results · 2 look relevant",
        },
      ],
      answer:
        "The tallest building in New York City is **One World Trade Center**: 1,776 ft (541 m) to the tip of its spire [1](https://skyscrapers.example/one-world-trade-center). Measured to the roof, Central Park Tower is taller [2](https://encyclopedia.example/wiki/Tallest_buildings_in_New_York_City).",
      sources: [
        {
          url: "https://skyscrapers.example/one-world-trade-center",
          title: "One World Trade Center — Skyscraper Index",
          snippet:
            "Completed in 2014, it rises 1,776 feet (541 m) to the tip of its spire, the tallest building in the Western Hemisphere.",
        },
        {
          url: "https://encyclopedia.example/wiki/Tallest_buildings_in_New_York_City",
          title: "List of tallest buildings in New York City",
          snippet: "Central Park Tower has the highest roof in the city, at 1,550 feet (472 m).",
        },
      ],
    },
    notePath,
    doneAt,
  );
}

function element(id: string, type: string, x: number, y: number, width: number, height: number) {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed: id.charCodeAt(0) * 1009 + id.charCodeAt(1),
    version: 1,
    versionNonce: id.charCodeAt(2) * 7919,
    isDeleted: false,
    boundElements: null,
    updated: 1_758_800_000_000,
    link: null,
    locked: false,
  } satisfies DrawingElement;
}

function label(id: string, containerId: string, text: string, x: number, y: number, width: number) {
  return {
    ...element(id, "text", x, y, width, 25),
    text,
    originalText: text,
    fontSize: 20,
    fontFamily: 5,
    textAlign: "center",
    verticalAlign: "middle",
    containerId,
    autoResize: true,
    lineHeight: 1.25,
  } satisfies DrawingElement;
}

/** Two beds joined by a path to a pond: shapes with labels and a bound arrow. */
function demoDrawing(): string {
  const bound = (text: string): DrawingBoundElement[] => [
    { id: text, type: "text" },
    { id: "pathArw1", type: "arrow" },
  ];
  const elements: DrawingElement[] = [
    {
      ...element("bedsA1b2", "rectangle", 0, 0, 180, 90),
      backgroundColor: "#b2f2bb",
      boundElements: bound("bedsTxt1"),
    },
    label("bedsTxt1", "bedsA1b2", "Raised beds", 5, 32, 170),
    {
      ...element("pondC3d4", "ellipse", 60, 190, 170, 90),
      backgroundColor: "#a5d8ff",
      boundElements: bound("pondTxt1"),
    },
    label("pondTxt1", "pondC3d4", "Pond", 95, 222, 100),
    {
      ...element("pathArw1", "arrow", 100, 96, 40, 88),
      points: [
        [0, 0],
        [40, 88],
      ],
      startBinding: { elementId: "bedsA1b2", focus: 0, gap: 6 },
      endBinding: { elementId: "pondC3d4", focus: 0, gap: 6 },
      startArrowhead: null,
      endArrowhead: "arrow",
      roundness: { type: 2 },
    },
  ];
  return serializeDrawingFile({ ...emptyDrawingScene(), elements });
}
