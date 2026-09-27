import SwiftUI

/// IDs and shortcuts mirror applicable Mac commands. Host administration stays in host settings.
enum PhoneCommandID: String, CaseIterable {
  case newNote = "note.new"
  case newFolder = "folder.new"
  case newDrawing = "drawing.new"
  case today = "daily.today"
  case tomorrow = "daily.tomorrow"
  case previousDaily = "daily.previous"
  case nextDaily = "daily.next"
  case weekly = "weekly.current"
  case quickOpen = "switcher.open"
  case palette = "palette.open"
  case search = "search.open"
  case save = "note.save"
  case rename = "note.rename"
  case trash = "note.delete"
  case close = "tab.close"
  case reopen = "tab.reopen"
  case nextTab = "tab.next"
  case previousTab = "tab.previous"
  case back = "nav.back"
  case forward = "nav.forward"
  case tab1 = "tab.1"
  case tab2 = "tab.2"
  case tab3 = "tab.3"
  case tab4 = "tab.4"
  case tab5 = "tab.5"
  case tab6 = "tab.6"
  case tab7 = "tab.7"
  case tab8 = "tab.8"
  case tab9 = "tab.9"
  case explorer = "sidebar.toggle"
  case inbox = "agent.inbox"
  case orchestrator = "agent.orchestrator"
  case routines = "routines.show"
  case newRoutine = "routine.new"
  case stop = "agent.stop"
  case capture = "capture.new"
  case history = "capture.history"
  case recovery = "recovery.open"
  case settings = "settings.open"
  case hostSettings = "settings.host"
  case connection = "connection.choose"
  case sync = "sync.now"
  case source = "editor.livePreview"
  case lineNumbers = "editor.lineNumbers"
  case readableWidth = "editor.readable"
  case fontLarger = "font.increase"
  case fontSmaller = "font.decrease"
  case fontReset = "font.reset"
  case find = "editor.find"
  case insertDrawing = "editor.insertDrawing"
  case bold = "editor.bold"
  case italic = "editor.italic"
  case code = "editor.code"
  case strike = "editor.strike"
  case highlight = "editor.highlight"
  case link = "editor.link"
  case checklist = "editor.checklist"
  case indent = "editor.indent"
  case outdent = "editor.outdent"
  case undo = "editor.undo"
  case redo = "editor.redo"
}

struct PhoneCommand: Identifiable {
  struct Shortcut: Hashable {
    let key: String
    let modifiers: EventModifiers
    init(_ key: String, _ modifiers: EventModifiers = .command) {
      self.key = key
      self.modifiers = modifiers
    }
    func hash(into hasher: inout Hasher) {
      hasher.combine(key)
      hasher.combine(modifiers.rawValue)
    }
    var display: String {
      (modifiers.contains(.control) ? "⌃" : "") + (modifiers.contains(.option) ? "⌥" : "")
        + (modifiers.contains(.shift) ? "⇧" : "") + (modifiers.contains(.command) ? "⌘" : "")
        + (key == "\t" ? "⇥" : key.uppercased())
    }
  }
  let id: PhoneCommandID
  let title: String
  let group: String
  let shortcut: Shortcut?
  var showsInPalette: Bool {
    id != .palette && !id.rawValue.hasPrefix("tab.") || id == .close || id == .reopen
      || id == .nextTab || id == .previousTab
  }

  init(_ id: PhoneCommandID, _ title: String, _ group: String, _ shortcut: Shortcut? = nil) {
    self.id = id
    self.title = title
    self.group = group
    self.shortcut = shortcut
  }

  static let all: [Self] =
    [
      .init(.newNote, "Create new note", "Notes", .init("n")),
      .init(.newFolder, "Create new folder", "Notes"),
      .init(.newDrawing, "Create new drawing", "Notes"),
      .init(.today, "Open today's daily note", "Notes", .init("d", [.command, .shift])),
      .init(.tomorrow, "Open tomorrow's daily note", "Notes"),
      .init(.previousDaily, "Open previous daily note", "Notes", .init("p", [.command, .shift])),
      .init(.nextDaily, "Open next daily note", "Notes", .init("n", [.command, .shift])),
      .init(.weekly, "Open this week's note", "Notes", .init("w", [.command, .shift])),
      .init(.save, "Save current note on iPhone", "Notes", .init("s")),
      .init(.rename, "Move or rename current note", "Notes"),
      .init(.trash, "Move current note to Trash", "Notes"),
      .init(.quickOpen, "Open quick switcher", "Navigation", .init("o")),
      .init(.palette, "Open command palette", "Navigation", .init("p")),
      .init(.search, "Search note contents", "Navigation", .init("f", [.command, .shift])),
      .init(.explorer, "Open file explorer", "Navigation", .init("s", [.command, .control])),
      .init(.back, "Go back", "Navigation", .init("[")),
      .init(.forward, "Go forward", "Navigation", .init("]")),
      .init(.close, "Close current tab", "Navigation", .init("w")),
      .init(.reopen, "Reopen closed tab", "Navigation", .init("t", [.command, .shift])),
      .init(.nextTab, "Go to next tab", "Navigation", .init("\t", .control)),
      .init(.previousTab, "Go to previous tab", "Navigation", .init("\t", [.control, .shift])),
      .init(.capture, "Capture a task", "Agent", .init("k", [.command, .shift])),
      .init(.inbox, "Open agent inbox", "Agent", .init("a", [.command, .shift])),
      .init(.orchestrator, "Open orchestrator chat", "Agent", .init("\\")),
      .init(.routines, "Show routines", "Agent", .init("r", [.command, .shift])),
      .init(.newRoutine, "Create new routine", "Agent", .init("n", [.command, .option])),
      .init(.stop, "Stop the visible task", "Agent", .init(".")),
      .init(.history, "Review capture history", "Recovery"),
      .init(.recovery, "Open recovery and pending actions", "Recovery"),
      .init(.sync, "Sync saved changes", "Connection"),
      .init(.settings, "Open iPhone settings", "Connection", .init(",")),
      .init(.hostSettings, "Open host and shared settings", "Connection"),
      .init(.connection, "Choose a connection", "Connection"),
      .init(.source, "Toggle current note source mode", "Editor"),
      .init(.lineNumbers, "Toggle current note line numbers", "Editor"),
      .init(.readableWidth, "Toggle current note readable width", "Editor"),
      .init(.fontLarger, "Increase current note font size", "Editor", .init("+")),
      .init(.fontSmaller, "Decrease current note font size", "Editor", .init("-")),
      .init(.fontReset, "Reset current note font size", "Editor", .init("0")),
      .init(.find, "Find in current note", "Editor", .init("f")),
      .init(
        .insertDrawing, "Insert drawing in current note", "Editor", .init("x", [.command, .shift])),
      .init(.bold, "Toggle bold", "Editor", .init("b")),
      .init(.italic, "Toggle italic", "Editor", .init("i")),
      .init(.code, "Toggle inline code", "Editor", .init("e")),
      .init(.strike, "Toggle strikethrough", "Editor"),
      .init(.highlight, "Toggle highlight", "Editor"),
      .init(.link, "Insert link", "Editor", .init("k")),
      .init(.checklist, "Toggle checklist", "Editor", .init("l", [.command, .shift])),
      .init(.indent, "Indent list item", "Editor"), .init(.outdent, "Outdent list item", "Editor"),
      .init(.undo, "Undo current note edit", "Editor"),
      .init(.redo, "Redo current note edit", "Editor"),
    ]
    + [PhoneCommandID.tab1, .tab2, .tab3, .tab4, .tab5, .tab6, .tab7, .tab8, .tab9].enumerated().map
  {
    .init(
      $0.element, $0.offset == 8 ? "Last tab" : "Tab \($0.offset + 1)", "Navigation",
      .init("\($0.offset + 1)"))
  }
}
