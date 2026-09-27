import DailyDoListUI

extension DrawingTool {
  public var shortcut: KeyShortcut { KeyShortcut(.character(keys[0]), []) }
}

extension DrawingCommand {
  public var shortcut: KeyShortcut {
    switch self {
    case .undo: KeyShortcut("z")
    case .redo: KeyShortcut("z", [.shift, .command])
    case .delete: KeyShortcut(.delete)
    case .duplicate: KeyShortcut("d")
    case .selectAll: KeyShortcut("a")
    case .lockTool: KeyShortcut(.character("q"), [])
    }
  }
}
