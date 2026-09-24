import AppKit
import DailyDoListEditor
import DailyDoListModels
import Foundation
import Observation

/// Semantic editor events the workspace handles.
@MainActor
protocol EditorCoordinatorHost: AnyObject {
  func editorDidEdit(_ path: String)
  func editorRecords(for path: String) -> [TaskAgentRecord]
  func editorDidClickBadge(_ badge: EditorBadge)
  func editorDidClickWikiLink(_ target: String, newTab: Bool)
  func editorDidMoveCursor(_ path: String, line: Int)
  func editorDidRequestSave(_ path: String)
}

/// Owns the window's single ``MarkdownEditorController``: switches documents with per-note
/// snapshots (text, selection, scroll, undo) for instant tab switches, keeps agent badges in sync
/// (immediately when records change, debounced ~150 ms while typing) and publishes a debounced word
/// count. Nothing here runs O(document) work per keystroke.
@MainActor
@Observable
final class EditorCoordinator {
  @ObservationIgnored let controller: MarkdownEditorController
  @ObservationIgnored weak var host: EditorCoordinatorHost?

  private(set) var activePath: String?
  private(set) var wordCount: Int?
  private(set) var cursorLine: Int?
  private(set) var configuration: EditorConfiguration

  @ObservationIgnored private var snapshots: [String: EditorSnapshot] = [:]
  @ObservationIgnored private var badgeTimer: IdleTimer!
  @ObservationIgnored private var wordTimer: IdleTimer!
  @ObservationIgnored private let scheduler: AppScheduler
  @ObservationIgnored private var badgeRefreshScheduled = false

  init(controller: MarkdownEditorController? = nil, scheduler: AppScheduler, badgeDelay: TimeInterval = 0.15, wordDelay: TimeInterval = 0.6) {
    let controller = controller ?? MarkdownEditorController()
    self.controller = controller
    self.scheduler = scheduler
    configuration = controller.configuration
    badgeTimer = IdleTimer(scheduler: scheduler, delay: badgeDelay) { [weak self] in self?.recomputeBadges() }
    wordTimer = IdleTimer(scheduler: scheduler, delay: wordDelay) { [weak self] in self?.updateWordCount() }
    controller.delegate = self
  }

  // MARK: - Documents

  /// Switches the editor to `path` (nil = no note). `content` is used when there's no snapshot;
  /// `caretAtEnd` then puts the caret after the last line instead of before the first.
  func show(_ path: String?, content: @autoclosure () -> String?, caretAtEnd: Bool = false) {
    guard path != activePath else { return }
    if let current = activePath { snapshots[current] = controller.snapshot() }
    activePath = path
    cursorLine = nil
    if let path, let snapshot = snapshots[path] {
      controller.restore(snapshot)
    } else {
      controller.setText(path == nil ? "" : content() ?? "", resetUndo: true)
      if caretAtEnd { controller.moveCaretToEnd() }
    }
    recomputeBadges()
    updateWordCount()
  }

  /// The current text of `path`: live for the active note, else from its snapshot.
  func liveText(for path: String) -> String? {
    path == activePath ? controller.text : snapshots[path]?.text
  }

  func hasSnapshot(_ path: String) -> Bool { snapshots[path] != nil }

  /// A newer server version (no local edits): minimal-diff update of the active note; inactive
  /// notes drop their snapshot and reload from the store when shown again.
  func applyRemote(_ content: String, to path: String) {
    if path == activePath {
      guard controller.text != content else { return }
      controller.setText(content)
      recomputeBadges()
      wordTimer.poke()
    } else {
      snapshots[path] = nil
    }
  }

  func forget(_ path: String) {
    snapshots[path] = nil
  }

  func rename(from: String, to: String) {
    for key in Array(snapshots.keys) {
      guard let next = NotePaths.renamed(key, from: from, to: to) else { continue }
      snapshots[next] = snapshots.removeValue(forKey: key)
    }
    if let activePath, let next = NotePaths.renamed(activePath, from: from, to: to) {
      self.activePath = next
    }
  }

  // MARK: - Configuration & focus

  func configure(_ settings: EditorSettings) {
    let next = EditorConfiguration(
      fontSize: settings.fontSize, livePreview: settings.livePreview,
      readableLineLength: settings.readableLineLength, spellcheck: settings.spellcheck,
      showLineNumbers: settings.showLineNumbers, isEditable: true)
    guard next != configuration else { return }
    configuration = next
    controller.configure(next)
  }

  func focus() {
    controller.focus()
  }

  func scrollToLine(_ line: Int) {
    controller.scrollToLine(line)
  }

  // MARK: - Badges & word count

  /// Rebuilds badges from the host's records against the current text (cheap when none).
  func recomputeBadges() {
    badgeTimer.cancel()
    guard let path = activePath, let host else {
      if !controller.badges.isEmpty { controller.setBadges([]) }
      return
    }
    let badges = BadgeBuilder.badges(for: host.editorRecords(for: path), in: controller.text)
    if badges != controller.badges { controller.setBadges(badges) }
  }

  /// Agent records changed for `notePath` (nil = unknown note): refresh on the next main-actor
  /// turn if it's shown, so a burst of record events costs one recompute.
  func recordsDidChange(for notePath: String?) {
    guard notePath == nil || notePath == activePath, !badgeRefreshScheduled else { return }
    badgeRefreshScheduled = true
    scheduler.schedule(after: 0) { [weak self] in
      self?.badgeRefreshScheduled = false
      self?.recomputeBadges()
    }
  }

  private func updateWordCount() {
    wordTimer.cancel()
    wordCount = activePath == nil ? nil : TextMetrics.countWords(controller.text)
  }
}

extension EditorCoordinator: MarkdownEditorDelegate {
  func editorTextDidChange(_ editor: MarkdownEditorController, text: String) {
    guard let path = activePath else { return }
    host?.editorDidEdit(path)
    if !(host?.editorRecords(for: path).isEmpty ?? true) { badgeTimer.poke() }
    wordTimer.poke()
  }

  func editor(_ editor: MarkdownEditorController, didClickBadge badge: EditorBadge) {
    host?.editorDidClickBadge(badge)
  }

  func editor(_ editor: MarkdownEditorController, didClickWikiLink target: String, newWindow: Bool) {
    host?.editorDidClickWikiLink(target, newTab: newWindow)
  }

  func editor(_ editor: MarkdownEditorController, didClickLink url: URL) {
    ExternalLinks.open(url)
  }

  func editor(_ editor: MarkdownEditorController, cursorDidMoveToLine line: Int) {
    cursorLine = line
    guard let path = activePath else { return }
    host?.editorDidMoveCursor(path, line: line)
  }

  func editorDidRequestSave(_ editor: MarkdownEditorController) {
    guard let path = activePath else { return }
    host?.editorDidRequestSave(path)
  }
}
