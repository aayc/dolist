import {
  type AppSettings,
  addDays,
  DEFAULT_DAILY_NOTE_CONTENT,
  dailyNotePath,
  type LocalDate,
  renderTemplate,
  stem,
  templateNotePath,
  today,
} from "@ddl/core";
import type { MockAgent } from "./mock-agent";
import { LIVING_LIST_LINES, RESTAURANTS_NOTE } from "./mock-demo";
import { DEMO_DRAWING_PATH, demoDrawing, SKETCHES_NOTE } from "./mock-drawings";
import type { MockVault } from "./mock-vault";

/**
 * Synthetic demo content only — no real people, places or accounts. Yesterday's note shows the
 * agent at work in a note (`living`); today's stays the empty template, ready for a task.
 */
const PAST_DAYS: Array<{
  offset: number;
  lines: readonly string[];
  completed: string[];
  living?: boolean;
}> = [
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
    completed: ["Compare standing desks under $400", "Order a replacement phone charger"],
    living: true,
  },
  {
    offset: -2,
    lines: [
      "- [x] Research beginner-friendly houseplants for a north-facing window",
      "- [ ] Call the bank about the card replacement",
      "- [x] Summarize the neighborhood newsletter",
    ],
    completed: ["Research beginner-friendly houseplants for a north-facing window"],
  },
  {
    offset: -4,
    lines: [
      "- [x] Plan a weekend hiking route near the lake",
      "- [ ] Back up the photo library",
      "- [x] Shortlist birthday gift ideas for Alex",
    ],
    completed: ["Plan a weekend hiking route near the lake"],
  },
];

const STATIC_NOTES: Record<string, string> = {
  "Welcome.md": [
    "# Welcome to Daily Do List",
    "",
    "This is an **in-browser demo vault**: nothing leaves your machine and nothing is saved.",
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
  "Restaurants.md": RESTAURANTS_NOTE,
  "Sketches.md": SKETCHES_NOTE,
};

export function renderDailyContent(
  vault: MockVault,
  date: LocalDate,
  settings: AppSettings,
  now: Date = new Date(),
): string {
  const templatePath = templateNotePath(settings.dailyNotes);
  const template = templatePath ? vault.get(templatePath)?.content : undefined;
  if (template === undefined) return DEFAULT_DAILY_NOTE_CONTENT;
  const title = stem(dailyNotePath(date, settings.dailyNotes));
  return renderTemplate(template, { title, date, now });
}

export function seedVault(vault: MockVault, agent: MockAgent, settings: AppSettings): void {
  const now = new Date();
  const templatePath = templateNotePath(settings.dailyNotes) ?? "Templates/Daily.md";
  vault.write(templatePath, DEFAULT_DAILY_NOTE_CONTENT, now.getTime() - 30 * 86_400_000);
  for (const [path, content] of Object.entries(STATIC_NOTES)) {
    vault.write(path, content, now.getTime() - 7 * 86_400_000);
  }
  vault.write(DEMO_DRAWING_PATH, demoDrawing(), now.getTime() - 7 * 86_400_000);
  const current = today(now);
  for (const day of PAST_DAYS) {
    const date = addDays(current, day.offset);
    const path = dailyNotePath(date, settings.dailyNotes);
    const mtime = now.getTime() + day.offset * 86_400_000;
    const content = day.lines.join("\n");
    vault.write(path, content, mtime);
    agent.observeNote(path, content, { initial: true });
    for (const text of day.completed) agent.seedCompletedTask(path, text, mtime);
    if (day.living) agent.seedLivingList(path, content, mtime);
  }
  const todayPath = dailyNotePath(current, settings.dailyNotes);
  const todayContent = renderDailyContent(vault, current, settings, now);
  vault.write(todayPath, todayContent, now.getTime());
  agent.observeNote(todayPath, todayContent, { initial: true });
}
