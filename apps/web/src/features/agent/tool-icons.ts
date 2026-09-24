import {
  AppWindow,
  Bot,
  FileCode,
  FileText,
  Globe,
  type LucideIcon,
  Monitor,
  NotebookPen,
  Plug,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";

/** Icon by tool family (names from packages/agent/src/tools/contracts.ts). */
export function toolIcon(toolName: string): LucideIcon {
  if (toolName.startsWith("mcp__")) return Plug;
  if (toolName.startsWith("browser_")) return AppWindow;
  if (toolName.startsWith("computer_")) return Monitor;
  if (toolName === "web_search") return Search;
  if (toolName.startsWith("web_")) return Globe;
  if (toolName === "bash") return Terminal;
  if (["read", "write", "edit", "grep", "find", "ls"].includes(toolName)) return FileCode;
  if (toolName === "read_note" || toolName === "search_notes") return NotebookPen;
  if (toolName === "create_artifact" || toolName === "post_update") return FileText;
  if (["spawn_subagent", "message_subagent", "cancel_subagent", "ask_user"].includes(toolName))
    return Bot;
  return Wrench;
}
