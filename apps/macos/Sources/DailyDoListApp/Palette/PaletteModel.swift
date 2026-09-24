import Foundation
import Observation

/// State of an open palette/switcher: query, ranked items, keyboard selection.
@MainActor
@Observable
final class PaletteModel {
  let mode: PaletteMode
  var query = "" {
    didSet {
      guard query != oldValue else { return }
      recompute()
      selectedIndex = 0
    }
  }
  private(set) var items: [PaletteItem] = []
  private(set) var selectedIndex = 0

  @ObservationIgnored private let commands: [AppCommand]
  @ObservationIgnored private let files: [String]
  @ObservationIgnored private let recent: [String]
  @ObservationIgnored private let openTabs: [String]

  init(
    mode: PaletteMode, commands: [AppCommand] = [], files: [String] = [], recent: [String] = [],
    openTabs: [String] = []
  ) {
    self.mode = mode
    self.commands = commands
    self.files = files
    self.recent = recent
    self.openTabs = openTabs
    recompute()
  }

  var selectedItem: PaletteItem? {
    items.indices.contains(selectedIndex) ? items[selectedIndex] : nil
  }

  var placeholder: String {
    mode == .commands ? "Type a command…" : "Find or create a note…"
  }

  /// The note name ⌘↩ would create (switcher only).
  var creatableName: String? {
    let name = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return mode == .switcher && !name.isEmpty ? name : nil
  }

  /// ↑/↓ (wraps around).
  func moveSelection(by delta: Int) {
    guard !items.isEmpty else {
      selectedIndex = 0
      return
    }
    selectedIndex = ((selectedIndex + delta) % items.count + items.count) % items.count
  }

  func select(_ index: Int) {
    if items.indices.contains(index) { selectedIndex = index }
  }

  func command(for item: PaletteItem) -> AppCommand? {
    guard case .command(let id) = item.kind else { return nil }
    return commands.first { $0.id == id }
  }

  private func recompute() {
    switch mode {
    case .commands:
      items = PaletteRanking.commands(query, from: commands)
    case .switcher:
      items =
        PaletteRanking.normalize(query).isEmpty
        ? PaletteRanking.defaultNotes(files: files, recent: recent, openTabs: openTabs)
        : PaletteRanking.notes(query, files: files)
    }
  }
}
