import DailyDoListDomain
import DailyDoListMobileEditor
import DailyDoListModels
import Foundation
import Observation

@MainActor @Observable
final class PhoneCommandController {
  enum Presentation: Identifiable {
    case palette(PhonePaletteMode)
    case path(PathAction, String, UInt64)
    case capture, history, recovery, newRoutine
    var id: String {
      switch self {
      case .palette: "palette"
      case .path: "path"
      case .capture: "capture"
      case .history: "history"
      case .recovery: "recovery"
      case .newRoutine: "routine"
      }
    }
  }
  enum PathAction { case note, folder, drawing, rename, trash }
  /// Weak: SwiftUI and UIKit can keep a command controller (its key commands) after the
  /// workspace is released, and a strong reference would keep every database it owns open.
  private(set) weak var workspace: PhoneWorkspace?
  var presentation: Presentation?
  private(set) var awaitingDismissal = false
  @ObservationIgnored var isCurrent: () -> Bool
  @ObservationIgnored var chooseConnection: () -> Void
  @ObservationIgnored var showHostSettings: () -> Void
  @ObservationIgnored var insertDrawing: (() -> Void)?
  @ObservationIgnored var visibleThread: () -> String?
  @ObservationIgnored private var afterDismiss: (() -> Void)?

  init(
    workspace: PhoneWorkspace, isCurrent: @escaping () -> Bool = { true },
    chooseConnection: @escaping () -> Void = {}, showHostSettings: @escaping () -> Void = {},
    insertDrawing: (() -> Void)? = nil, visibleThread: @escaping () -> String? = { nil }
  ) {
    self.workspace = workspace
    self.isCurrent = isCurrent
    self.chooseConnection = chooseConnection
    self.showHostSettings = showHostSettings
    self.insertDrawing = insertDrawing
    self.visibleThread = visibleThread
  }

  var availableCommands: [PhoneCommand] {
    PhoneCommand.all.filter { $0.showsInPalette && canRun($0.id) }
  }
  var editorAvailable: Bool {
    guard let workspace else { return false }
    return workspace.selectedTab == 0 && workspace.active != nil && !workspace.structuralBusy
  }

  func canRun(_ id: PhoneCommandID) -> Bool {
    guard isCurrent(), let workspace else { return false }
    let hasNote = workspace.activePath != nil && !workspace.structuralBusy
    let editable = editorAvailable && workspace.active?.editor.configuration.isEditable == true
    switch id {
    case .rename, .trash: return hasNote && workspace.online
    case .newFolder: return workspace.online && !workspace.structuralBusy
    case .newNote, .newDrawing, .today, .tomorrow, .weekly, .capture:
      return !workspace.structuralBusy
    case .previousDaily, .nextDaily: return !workspace.structuralBusy && workspace.settings != nil
    case .save, .close: return hasNote
    case .reopen: return !workspace.structuralBusy && workspace.tabs.canReopenClosedTab
    case .back: return !workspace.structuralBusy && workspace.tabs.canGoBack
    case .forward: return !workspace.structuralBusy && workspace.tabs.canGoForward
    case .nextTab, .previousTab: return !workspace.structuralBusy && workspace.tabs.tabs.count > 1
    case .tab1, .tab2, .tab3, .tab4, .tab5, .tab6, .tab7, .tab8, .tab9:
      return !workspace.structuralBusy && workspace.tabs.tab(forShortcut: tabNumber(id)) != nil
    case .sync: return workspace.online && !workspace.refreshing && !workspace.structuralBusy
    case .newRoutine:
      return workspace.online && workspace.agent != nil && workspace.agent?.readOnly == nil
    case .stop:
      guard workspace.online, let id = visibleThread(), let agent = workspace.agent else {
        return false
      }
      return agent.readOnly == nil && agent.threadStatus(id)?.isActive == true
    case .orchestrator, .inbox, .routines: return workspace.agent != nil
    case .source, .lineNumbers, .readableWidth, .fontLarger, .fontSmaller, .fontReset, .find:
      return editorAvailable
    case .insertDrawing: return editable && insertDrawing != nil
    case .bold, .italic, .code, .strike, .highlight, .link, .checklist, .indent, .outdent, .undo,
      .redo:
      return editable && workspace.active?.editor.input.markedTextRange == nil
    default: return true
    }
  }

  @discardableResult func run(_ id: PhoneCommandID) -> Bool {
    guard !awaitingDismissal, canRun(id) else { return false }
    if presentation != nil {
      awaitingDismissal = true
      afterDismiss = { [weak self] in _ = self?.run(id) }
      presentation = nil
      return true
    }
    guard let workspace else { return false }
    switch id {
    case .palette: presentation = .palette(.commands)
    case .quickOpen: presentation = .palette(.notes)
    case .search: presentation = .palette(.contents)
    case .newNote: presentation = .path(.note, "", workspace.generation)
    case .newDrawing: presentation = .path(.drawing, "Excalidraw/Untitled", workspace.generation)
    case .newFolder: presentation = .path(.folder, "", workspace.generation)
    case .rename, .trash:
      if let path = workspace.activePath {
        presentation = .path(id == .rename ? .rename : .trash, path, workspace.generation)
      }
    case .capture: presentation = .capture
    case .history: presentation = .history
    case .recovery: presentation = .recovery
    case .newRoutine: presentation = .newRoutine
    case .today: Task { await workspace.openToday() }
    case .tomorrow:
      Task {
        await workspace.openDaily(LocalDate(date: Date(), timeZone: .current).adding(days: 1))
      }
    case .weekly: Task { await workspace.openWeekly() }
    case .previousDaily: Task { await workspace.openAdjacentDaily(.previous) }
    case .nextDaily: Task { await workspace.openAdjacentDaily(.next) }
    case .save: Task { await workspace.checkpointAll(finishComposition: true) }
    case .close: if let path = workspace.activePath { Task { await workspace.closeNote(path) } }
    case .reopen: Task { await workspace.reopenNote() }
    case .back: Task { await workspace.goBack() }
    case .forward: Task { await workspace.goForward() }
    case .nextTab, .previousTab:
      if let path = workspace.tabs.adjacentTab(id == .nextTab ? 1 : -1) { open(path) }
    case .tab1, .tab2, .tab3, .tab4, .tab5, .tab6, .tab7, .tab8, .tab9:
      if let path = workspace.tabs.tab(forShortcut: tabNumber(id)) { open(path) }
    case .explorer: workspace.selectedTab = 1
    case .inbox: workspace.selectedTab = 2
    case .routines: workspace.selectedTab = 3
    case .settings: workspace.selectedTab = 4
    case .orchestrator: workspace.routedThread = PhoneThreadDestination(id: OrchestratorThread.id)
    case .hostSettings: showHostSettings()
    case .connection: chooseConnection()
    case .sync: Task { await workspace.synchronize() }
    case .stop:
      if let thread = visibleThread() { Task { await workspace.agent?.cancelThread(thread) } }
    case .insertDrawing: insertDrawing?()
    case .find:
      if let input = workspace.active?.editor.input {
        input.isFindInteractionEnabled = true
        input.findInteraction?.presentFindNavigator(showingReplace: false)
      }
    case .source, .lineNumbers, .readableWidth, .fontLarger, .fontSmaller, .fontReset:
      updateEditor(id)
    default:
      if let command = editingCommand(id), let editor = workspace.active?.editor {
        _ = editor.run(command)
        editor.input.becomeFirstResponder()
      }
    }
    return true
  }

  func dismissed() {
    let action = afterDismiss
    afterDismiss = nil
    awaitingDismissal = false
    guard isCurrent() else { return }
    action?()
  }

  func open(_ path: String, newTab: Bool = false, line: Int? = nil) {
    guard isCurrent(), workspace?.structuralBusy == false else { return }
    let action = { [weak self] in
      guard let self, self.isCurrent(), let workspace = self.workspace else { return }
      Task { await workspace.open(path, newTab: newTab, line: line) }
    }
    if presentation != nil {
      awaitingDismissal = true
      afterDismiss = action
      presentation = nil
    } else {
      action()
    }
  }

  func createFromQuery(_ query: String) {
    guard canRun(.newNote), !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return
    }
    awaitingDismissal = true
    afterDismiss = { [weak self] in
      guard let self, self.canRun(.newNote), let workspace = self.workspace else { return }
      self.presentation = .path(
        .note, query.trimmingCharacters(in: .whitespacesAndNewlines), workspace.generation)
    }
    presentation = nil
  }

  func completePath(_ action: PathAction, original: String, path: String, epoch: UInt64) {
    guard isCurrent(), let workspace, workspace.generation == epoch, !workspace.structuralBusy
    else { return }
    awaitingDismissal = true
    afterDismiss = { [weak self] in
      guard let self, self.isCurrent(), let workspace = self.workspace,
        workspace.generation == epoch
      else { return }
      Task {
        switch action {
        case .note: await workspace.createNote(path)
        case .drawing: await workspace.createDrawing(path)
        case .folder: await workspace.createFolder(path)
        case .rename:
          await workspace.changeStructure(.rename(from: original, to: path, isFolder: false))
        case .trash: await workspace.changeStructure(.trash(path: original, isFolder: false))
        }
      }
    }
    presentation = nil
  }

  private func tabNumber(_ id: PhoneCommandID) -> Int { Int(id.rawValue.dropFirst(4)) ?? 0 }

  private func updateEditor(_ id: PhoneCommandID) {
    guard let editor = workspace?.active?.editor else { return }
    var value = editor.configuration
    switch id {
    case .source: value.livePreview.toggle()
    case .lineNumbers: value.showLineNumbers.toggle()
    case .readableWidth: value.readableLineLength.toggle()
    case .fontLarger: value.fontSize = min(40, value.fontSize + 1)
    case .fontSmaller: value.fontSize = max(8, value.fontSize - 1)
    case .fontReset: value.fontSize = EditorSettings.defaults.fontSize
    default: return
    }
    editor.updateConfiguration(value)
  }

  private func editingCommand(_ id: PhoneCommandID) -> MobileMarkdownController.Command? {
    switch id {
    case .bold: .bold
    case .italic: .italic
    case .code: .code
    case .strike: .strike
    case .highlight: .highlight
    case .link: .link
    case .checklist: .checklist
    case .indent: .indent
    case .outdent: .outdent
    case .undo: .undo
    case .redo: .redo
    default: nil
    }
  }
}
