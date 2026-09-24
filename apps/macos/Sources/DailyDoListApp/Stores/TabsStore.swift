import Foundation
import Observation

/// Open-note tabs of the window plus navigation history (back/forward) and recently closed tabs.
///
/// Placement follows Obsidian: navigating replaces the active tab's note unless the note is already
/// open (that tab is activated) or a new tab is requested. History is window-wide: Back returns to
/// the previously active note wherever it is (like Xcode/VS Code "Go Back").
@MainActor
@Observable
final class TabsStore {
  struct ClosedTab: Equatable, Sendable {
    let path: String
    let index: Int
  }

  private(set) var tabs: [String] = []
  private(set) var active: String?
  private(set) var backStack: [String] = []
  private(set) var forwardStack: [String] = []
  private(set) var closedTabs: [ClosedTab] = []

  @ObservationIgnored private let historyLimit = 100
  @ObservationIgnored private let closedLimit = 20

  var canGoBack: Bool { !backStack.isEmpty }
  var canGoForward: Bool { !forwardStack.isEmpty }
  var canReopenClosedTab: Bool { !closedTabs.isEmpty }

  /// Shows `path`: activates its tab if open, else replaces the active tab (or opens a new one).
  func place(_ path: String, newTab: Bool = false, recordHistory: Bool = true) {
    let previous = active
    if !tabs.contains(path) {
      if let active, let index = tabs.firstIndex(of: active) {
        if newTab { tabs.insert(path, at: index + 1) } else { tabs[index] = path }
      } else {
        tabs.append(path)
      }
    }
    active = path
    if recordHistory { record(from: previous, to: path) }
  }

  /// Restores tabs (launch); unknown paths are the caller's business.
  func restore(tabs: [String], active: String?) {
    var seen = Set<String>()
    self.tabs = tabs.filter { seen.insert($0).inserted }
    self.active = active.flatMap { self.tabs.contains($0) ? $0 : nil } ?? self.tabs.first
  }

  /// Closes `path`'s tab; returns the note that becomes active (right neighbour first).
  @discardableResult
  func close(_ path: String) -> String? {
    guard let index = tabs.firstIndex(of: path) else { return active }
    tabs.remove(at: index)
    closedTabs.append(ClosedTab(path: path, index: index))
    if closedTabs.count > closedLimit { closedTabs.removeFirst(closedTabs.count - closedLimit) }
    if active == path {
      let next = index < tabs.count ? tabs[index] : tabs.last
      active = next
      if let next { record(from: path, to: next) }
    }
    return active
  }

  /// Pops the most recently closed tab (skipping ones that are open again) and reinserts it at
  /// its old position. Returns its path; the caller loads and activates it.
  func popClosedTab(isValid: (String) -> Bool = { _ in true }) -> ClosedTab? {
    while let closed = closedTabs.popLast() {
      if tabs.contains(closed.path) || !isValid(closed.path) { continue }
      return closed
    }
    return nil
  }

  /// Opens `closed` again at its previous index and activates it.
  func reinsert(_ closed: ClosedTab) {
    let previous = active
    if !tabs.contains(closed.path) {
      tabs.insert(closed.path, at: min(max(0, closed.index), tabs.count))
    }
    active = closed.path
    record(from: previous, to: closed.path)
  }

  /// Target of Back (moves the current note onto the forward stack). The caller opens it with
  /// `recordHistory: false`.
  func popBack(isValid: (String) -> Bool = { _ in true }) -> String? {
    while let target = backStack.popLast() {
      guard isValid(target), target != active else { continue }
      if let active { forwardStack.append(active) }
      return target
    }
    return nil
  }

  func popForward(isValid: (String) -> Bool = { _ in true }) -> String? {
    while let target = forwardStack.popLast() {
      guard isValid(target), target != active else { continue }
      if let active { backStack.append(active) }
      return target
    }
    return nil
  }

  /// ⌘1…⌘8 select that tab; ⌘9 selects the last one (like browsers and Obsidian).
  func tab(forShortcut number: Int) -> String? {
    guard !tabs.isEmpty, (1...9).contains(number) else { return nil }
    if number == 9 { return tabs.last }
    return number <= tabs.count ? tabs[number - 1] : nil
  }

  /// Neighbouring tab for ⇧⌘[ / ⇧⌘] (wraps around).
  func adjacentTab(_ offset: Int) -> String? {
    guard let active, let index = tabs.firstIndex(of: active), tabs.count > 1 else { return nil }
    return tabs[(index + offset % tabs.count + tabs.count) % tabs.count]
  }

  /// Rewrites every reference after a rename of a note or folder.
  func rename(from: String, to: String) {
    func map(_ path: String) -> String { NotePaths.renamed(path, from: from, to: to) ?? path }
    tabs = tabs.map(map)
    active = active.map(map)
    backStack = backStack.map(map)
    forwardStack = forwardStack.map(map)
    closedTabs = closedTabs.map { ClosedTab(path: map($0.path), index: $0.index) }
  }

  /// Forgets a deleted note everywhere (its tab is closed separately via ``close(_:)``).
  func purge(_ path: String) {
    backStack.removeAll { $0 == path }
    forwardStack.removeAll { $0 == path }
    closedTabs.removeAll { $0.path == path }
    collapseDuplicates()
  }

  private func record(from previous: String?, to next: String) {
    guard let previous, previous != next else { return }
    if backStack.last != previous { backStack.append(previous) }
    if backStack.count > historyLimit { backStack.removeFirst(backStack.count - historyLimit) }
    forwardStack.removeAll()
  }

  private func collapseDuplicates() {
    backStack = backStack.reduce(into: []) { if $0.last != $1 { $0.append($1) } }
    forwardStack = forwardStack.reduce(into: []) { if $0.last != $1 { $0.append($1) } }
  }
}
