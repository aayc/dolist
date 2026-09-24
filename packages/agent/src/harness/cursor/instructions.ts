import type { ToolSpec } from "@ddl/core";

export interface InstructionsInput {
  systemPrompt: string;
  serverName: string;
  tools: readonly ToolSpec[];
  /** The task workspace our file and shell tools work in. */
  taskWorkspace: string;
  hasFileTools: boolean;
  hasShell: boolean;
  webAllowed: boolean;
}

/**
 * The session's AGENTS.md, which the CLI reads as project instructions: our system prompt, how
 * tools work in this harness, and the tools' prompt guidelines (as the Pi harness appends them).
 */
export function buildAgentsMd(input: InstructionsInput): string {
  const names = input.tools.map((tool) => tool.name).join(", ");
  const lines = [
    input.systemPrompt.trim(),
    "",
    "---",
    "",
    "## Tools in this session",
    "",
    `Use only the tools of the \`${input.serverName}\` MCP server: ${names || "(none)"}.`,
    "Cursor's own tools for reading, writing, editing and deleting files, the terminal, web fetch, subagents (Task) and questions are switched off here and fail with a permission error, so don't call them.",
  ];
  if (input.hasFileTools || input.hasShell) {
    const which = [input.hasFileTools ? "file" : "", input.hasShell ? "shell" : ""]
      .filter(Boolean)
      .join(" and ");
    lines.push(
      `Your ${which} tools (\`${input.serverName}\` MCP) work in the task workspace, ${input.taskWorkspace}; paths are relative to it.`,
    );
  }
  lines.push(
    input.webAllowed
      ? "Cursor's web search is available and each search goes through the user's safety checks."
      : "You have no web access in this session.",
    "Ask the user questions only through your tools (for example ask_user), never with Cursor's question tool.",
    `If a \`${input.serverName}\` tool answers that it is still running, don't call it again: end your turn. Its result arrives in a follow-up message.`,
  );
  const guidelines = input.tools.flatMap((tool) =>
    (tool.promptGuidelines ?? []).map((line) => `- ${tool.name}: ${line.trim()}`),
  );
  if (guidelines.length > 0) lines.push("", "Tool usage guidelines:", ...guidelines);
  return `${lines.join("\n")}\n`;
}
