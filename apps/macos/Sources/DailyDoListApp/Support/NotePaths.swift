import DailyDoListDomain
import DailyDoListModels
import Foundation

/// App-level note naming helpers (the web workspace's rules) on top of Domain's `VaultPath`.
enum NotePaths {
  /// Characters Obsidian refuses in note names (plus leading dots).
  static let invalidNameCharacters = CharacterSet(charactersIn: "\\/:*?\"<>|#^[]")

  /// Why `name` can't be a note or folder name, or nil when it's fine.
  static func validateName(_ name: String) -> String? {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "Name can't be empty" }
    if trimmed.hasPrefix(".") { return "Name can't start with a dot" }
    if trimmed.rangeOfCharacter(from: invalidNameCharacters) != nil {
      return "Name can't contain any of \\ / : * ? \" < > | # ^ [ ]"
    }
    return nil
  }

  /// True when `path` is `folder` itself or inside it.
  static func isSameOrInside(_ path: String, _ folder: String) -> Bool {
    path == folder || path.hasPrefix("\(folder)/")
  }

  /// Rewrites `path` for a rename of `from` → `to` (a note or a folder containing it).
  static func renamed(_ path: String, from: String, to: String) -> String? {
    if path == from { return to }
    if path.hasPrefix("\(from)/") { return to + path.dropFirst(from.count) }
    return nil
  }

  /// `folder/base.md`, `folder/base 1.md`, … — the first path `exists` doesn't know.
  static func uniquePath(folder: String, base: String, fileExtension: String = ".md", exists: (String) -> Bool) -> String {
    let prefix = folder.isEmpty ? "" : "\(folder)/"
    var n = 0
    while true {
      let candidate = "\(prefix)\(n == 0 ? base : "\(base) \(n)")\(fileExtension)"
      if !exists(candidate) { return candidate }
      n += 1
    }
  }

  /// Explorer display name: markdown files without `.md`.
  static func displayName(_ path: String, isFolder: Bool) -> String {
    VaultTree.displayName(path: path, kind: isFolder ? .folder : .file)
  }

  /// Strips a `#heading` / `|alias` suffix from a raw wikilink target.
  static func wikiLinkTarget(_ raw: String) -> String {
    var target = raw
    if let bar = target.firstIndex(of: "|") { target = String(target[..<bar]) }
    if let hash = target.firstIndex(of: "#") { target = String(target[..<hash]) }
    return target.trimmingCharacters(in: .whitespaces)
  }
}
