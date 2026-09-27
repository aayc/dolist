/// SF Symbols by tool family (names from `packages/agent/src/tools/contracts.ts`).
public enum ToolIcon {
  public static func systemName(for toolName: String) -> String {
    if toolName.hasPrefix("mcp__") { return "puzzlepiece.extension" }
    if toolName.hasPrefix("browser_") { return "globe" }
    if toolName.hasPrefix("computer_") { return "cursorarrow.rays" }
    if toolName.hasPrefix("web_") { return "magnifyingglass" }
    switch toolName {
    case "bash": return "terminal"
    case "read": return "doc.text"
    case "write", "edit": return "square.and.pencil"
    case "grep", "find": return "doc.text.magnifyingglass"
    case "ls": return "folder"
    case "read_note", "search_notes": return "note.text"
    case "read_drawing": return "scribble.variable"
    case "post_update", "post_comment": return "text.bubble"
    case "ask_user": return "questionmark.bubble"
    case "create_artifact": return "doc.richtext"
    case "finish_task", "set_task_status": return "checklist"
    case "list_tasks": return "list.bullet"
    case "spawn_subagent", "message_subagent", "cancel_subagent": return "person.2"
    case "mock_irreversible_action": return "exclamationmark.triangle"
    default: return "wrench.and.screwdriver"
    }
  }
}
