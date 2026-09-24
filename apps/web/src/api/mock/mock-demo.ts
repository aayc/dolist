import type { CitedSource, MessageAuthor, TaskAgentStatus } from "@ddl/core";

/**
 * A daily note the agent has worked in (synthetic demo content only): an agent-written sub-bullet
 * citing a source under a task, an agent-written follow-up task, and a question written as prose
 * with a thread anchored to its line. The threads cite numbered sources and a [[wikilink]].
 */
export const DEMO_DINNER_THREAD = "thr_demo_dinner";
export const DEMO_QUESTION_THREAD = "thr_demo_tallest";
export const DEMO_QUESTION_ANCHOR = "anc_demo_tallest";
export const DEMO_DINNER_TASK = "Book a table for Friday dinner";
export const DEMO_QUESTION = "What's the tallest building in NYC?";

const TABLES_URL = "https://tables.example/r/trattoria-sole";

export const LIVING_LIST_LINES: readonly string[] = [
  `- [ ] ${DEMO_DINNER_TASK}`,
  `\t- Trattoria Sole has a table for 2 at 7:00 PM ([Tables](${TABLES_URL})) %%agent:${DEMO_DINNER_THREAD}%%`,
  `- [ ] Call the restaurant to confirm %%agent:${DEMO_DINNER_THREAD}%%`,
  "",
  DEMO_QUESTION,
];

export const RESTAURANTS_NOTE = [
  "# Restaurants",
  "",
  "Places we liked, and what to order.",
  "",
  "- Trattoria Sole — fresh pasta, quiet back room",
  "\t- Fridays fill up: book ahead",
  "- Blue Door Café — weekend brunch",
  "- Noodle Bar on 3rd — quick lunch",
].join("\n");

export interface DemoStep {
  toolName: string;
  label: string;
  input: unknown;
  resultPreview: string;
}

export interface DemoThread {
  id: string;
  /** Task id, or the line anchor's id. */
  taskId: string | null;
  title: string;
  author: MessageAuthor;
  intro: string;
  steps: DemoStep[];
  answer: string;
  sources: CitedSource[];
  status: TaskAgentStatus;
  summary: string;
  unread: number;
}

export function dinnerThread(taskId: string): DemoThread {
  return {
    id: DEMO_DINNER_THREAD,
    taskId,
    title: DEMO_DINNER_TASK,
    author: "subagent:research",
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
    status: "done",
    summary: "Table for 2 · 7 PM",
    unread: 0,
  };
}

export function questionThread(): DemoThread {
  return {
    id: DEMO_QUESTION_THREAD,
    taskId: DEMO_QUESTION_ANCHOR,
    title: DEMO_QUESTION,
    author: "subagent:research",
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
    status: "done",
    summary: "One World Trade Center",
    unread: 1,
  };
}
