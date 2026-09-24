import DailyDoListAgent
import DailyDoListClient
import DailyDoListDomain
import Foundation

/// Hover previews of `[[wikilinks]]` (the editor's tooltips, the thread view's cards): the note's
/// name and first non-empty lines, agent markers stripped. Open notes are read from the editor
/// and the notes store; others through the daemon's read-note API, cached until they change.
@MainActor
final class NotePreviewCache {
  static let lineCount = 8

  /// Wikilink target → vault path (nil: no such note).
  private let resolve: @MainActor (String) -> String?
  /// The content of a note that's open or loaded (fresher than the daemon's).
  private let loadedContent: @MainActor (String) -> String?
  private let read: @MainActor (String) async throws -> String
  private var cache: [String: NotePreview] = [:]
  private var loads: [String: Task<NotePreview?, Never>] = [:]

  init(
    resolve: @escaping @MainActor (String) -> String?, loadedContent: @escaping @MainActor (String) -> String?,
    read: @escaping @MainActor (String) async throws -> String
  ) {
    self.resolve = resolve
    self.loadedContent = loadedContent
    self.read = read
  }

  /// The preview of `target` if it's known now (open, or loaded earlier); nil otherwise.
  func cachedPreview(for target: String) -> NotePreview? {
    guard let path = resolve(target) else { return nil }
    if let content = loadedContent(path) { return Self.preview(path: path, content: content) }
    return cache[path]
  }

  /// The preview of `target`, reading the note when needed (nil when there's no such note or it
  /// can't be read).
  func preview(for target: String) async -> NotePreview? {
    if let known = cachedPreview(for: target) { return known }
    guard let path = resolve(target) else { return nil }
    if let load = loads[path] { return await load.value }
    let load = Task { [read] () -> NotePreview? in
      guard let content = try? await read(path) else { return nil }
      return Self.preview(path: path, content: content)
    }
    loads[path] = load
    let preview = await load.value
    loads[path] = nil
    if let preview { cache[path] = preview }
    return preview
  }

  /// Starts reading `target` so a later `cachedPreview` has it.
  func prefetch(_ target: String) {
    guard cachedPreview(for: target) == nil, let path = resolve(target), loads[path] == nil else { return }
    Task { _ = await self.preview(for: target) }
  }

  /// The note at `path` changed or went away.
  func invalidate(_ path: String) {
    cache[path] = nil
  }

  /// The note's name and its first non-empty lines (frontmatter skipped, agent markers stripped).
  static func preview(path: String, content: String) -> NotePreview {
    var lines = TextTools.splitLines(content)
    if lines.first?.trimmingCharacters(in: .whitespaces) == "---",
      let close = lines.dropFirst().firstIndex(where: { ["---", "..."].contains($0.trimmingCharacters(in: .whitespaces)) })
    {
      lines.removeSubrange(0...close)
    }
    let body = lines.lazy.map { AgentText.stripMarker($0) }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    return NotePreview(title: VaultPath.stem(path), lines: Array(body.prefix(lineCount)))
  }
}
