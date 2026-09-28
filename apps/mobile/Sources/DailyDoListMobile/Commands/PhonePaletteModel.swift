import DailyDoListDomain
import DailyDoListMobileKit
import DailyDoListModels
import DailyDoListWorkspaceCore
import Foundation
import Observation

enum PhonePaletteMode: String, CaseIterable, Identifiable {
  case notes = "Notes"
  case commands = "Commands"
  case contents = "Contents"
  var id: String { rawValue }
}

struct PhonePaletteItem: Identifiable {
  enum Target {
    case note(String, Int?)
    case command(PhoneCommandID)
  }
  let id: String
  let title: String
  let detail: String?
  let highlights: [Int]
  let shortcut: String?
  let target: Target
}

@MainActor @Observable
final class PhonePaletteModel {
  let controller: PhoneCommandController
  var mode: PhonePaletteMode { didSet { recompute() } }
  var query = "" { didSet { if oldValue != query { recompute() } } }
  private(set) var items: [PhonePaletteItem] = []
  private(set) var selectedIndex = 0
  private(set) var searching = false
  private(set) var coverage = ""
  private(set) var cached: Set<String> = []
  @ObservationIgnored private var searchGeneration: UInt64 = 0
  @ObservationIgnored private let debounce: @Sendable () async throws -> Void

  init(
    mode: PhonePaletteMode, controller: PhoneCommandController,
    debounce: @escaping @Sendable () async throws -> Void = {
      try await Task.sleep(for: .milliseconds(150))
    }
  ) {
    self.debounce = debounce
    self.mode = mode
    self.controller = controller
    recompute()
  }
  var selected: PhonePaletteItem? {
    items.indices.contains(selectedIndex) ? items[selectedIndex] : nil
  }
  var canCreate: Bool {
    mode == .notes && !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && controller.canRun(.newNote)
  }

  func move(_ delta: Int) {
    selectedIndex = QuickOpenRanking.movingSelection(selectedIndex, by: delta, count: items.count)
  }
  func select(_ index: Int) { if items.indices.contains(index) { selectedIndex = index } }

  func refresh() async {
    guard let workspace = controller.workspace else { return }
    let epoch = workspace.generation
    do {
      let metadata = try await workspace.repository.cachedDocumentMetadata()
      guard controller.isCurrent(), epoch == workspace.generation else { return }
      cached = Set(metadata.map(\.path))
      if mode != .contents { recompute() }
    } catch { coverage = "Downloaded-note information unavailable" }
  }

  func searchContents() async {
    guard mode == .contents else { return }
    let request = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !request.isEmpty else {
      coverage = "Search the text of downloaded notes or the connected vault"
      return
    }
    searchGeneration &+= 1
    let generation = searchGeneration
    guard let workspace = controller.workspace else { return }
    let epoch = workspace.generation
    searching = true
    defer { if generation == searchGeneration { searching = false } }
    func current() -> Bool {
      !Task.isCancelled && controller.isCurrent() && generation == searchGeneration
        && workspace.generation == epoch && mode == .contents
        && query.trimmingCharacters(in: .whitespacesAndNewlines) == request
    }
    do {
      try await debounce()
      let local = try await workspace.repository.search(request)
      guard current() else { return }
      show(local.hits)
      coverage =
        local.isComplete
        ? "Downloaded notes (\(local.downloadedNotes))"
        : "Downloaded notes · limited scan (\(local.searchedNotes)/\(local.downloadedNotes))"
      if let client = workspace.client, workspace.online {
        let remote = try await client.search(request, limit: 100)
        let metadata = try await workspace.repository.cachedDocumentMetadata()
        guard current() else { return }
        let dirty = Set(metadata.filter { $0.state != .synced }.map(\.path))
        show(
          Array(
            (local.hits.filter { dirty.contains($0.path) }
              + remote.hits.filter { !dirty.contains($0.path) }).prefix(100)))
        coverage =
          local.isComplete
          ? "Entire vault · includes unsynced iPhone edits"
          : "Host results · limited scan of iPhone edits"
      }
    } catch is CancellationError {
    } catch { if current() { coverage = "Downloaded notes · host search unavailable" } }
  }

  func activate(_ item: PhonePaletteItem, newTab: Bool = false) {
    switch item.target {
    case .note(let path, let line): controller.open(path, newTab: newTab, line: line)
    case .command(let command): controller.run(command)
    }
  }

  private func recompute() {
    searchGeneration &+= 1
    searching = false
    selectedIndex = 0
    guard let workspace = controller.workspace else {
      items = []
      return
    }
    switch mode {
    case .commands:
      let commands = controller.availableCommands
      items = QuickOpenRanking.commands(
        query, from: commands.map { .init(id: $0.id.rawValue, title: $0.title) }
      ).compactMap { ranked in
        guard let command = commands.first(where: { $0.id.rawValue == ranked.id }) else {
          return nil
        }
        return PhonePaletteItem(
          id: ranked.id, title: ranked.title, detail: command.group, highlights: ranked.highlights,
          shortcut: command.shortcut?.display, target: .command(command.id))
      }
      coverage = "Available commands"
    case .notes:
      let files = Set(
        workspace.entries.filter { $0.kind == .file && VaultPath.isMarkdown($0.path) }.map(\.path)
      ).union(cached)
      let ranked =
        QuickOpenRanking.normalize(query).isEmpty
        ? QuickOpenRanking.defaultNotes(
          files: Array(files), recent: Array(workspace.tabs.backStack.reversed()),
          openTabs: workspace.tabs.tabs)
        : QuickOpenRanking.notes(query, files: Array(files))
      items = ranked.map { row in
        let availability = cached.contains(row.id) ? "Downloaded" : "Requires connection"
        return PhonePaletteItem(
          id: row.id, title: row.title,
          detail: [row.subtitle, availability].compactMap { $0 }.joined(separator: " · "),
          highlights: row.highlights, shortcut: nil, target: .note(row.id, nil))
      }
      coverage =
        workspace.online
        ? "Names and paths in this workspace" : "Offline · downloaded notes open immediately"
    case .contents: items = []
    }
  }

  private func show(_ hits: [SearchHit]) {
    items = hits.enumerated().map { index, hit in
      PhonePaletteItem(
        id: "hit-\(index)", title: hit.path,
        detail: hit.kind == .content ? "Line \(hit.line + 1) · \(hit.preview)" : nil,
        highlights: [], shortcut: nil,
        target: .note(hit.path, hit.kind == .content ? hit.line : nil))
    }
    selectedIndex = min(selectedIndex, max(0, items.count - 1))
  }
}
