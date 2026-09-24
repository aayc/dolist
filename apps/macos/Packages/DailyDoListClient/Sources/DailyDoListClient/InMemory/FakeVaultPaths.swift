import DailyDoListModels
import Foundation

/// The daemon's vault path rules (`@ddl/core` paths + `apps/daemon/src/vault-paths.ts`).
enum FakeVaultPaths {
  static let sidecar = ".daily-do-list"
  static let trash = ".trash"

  /// Text formats the notes API reads and writes.
  static let textNoteExtensions: Set<String> = [
    ".md", ".markdown", ".txt", ".canvas", ".base", ".json", ".csv", ".tsv", ".yaml", ".yml",
  ]

  struct EscapeError: Error {}

  /// Canonical vault form: `/`-separated, no empty/`.` segments, `..` resolved (throws on escape).
  static func normalize(_ input: String) throws(EscapeError) -> String {
    if input.contains("\0") { throw EscapeError() }
    var segments: [Substring] = []
    for segment in input.replacingOccurrences(of: "\\", with: "/").split(separator: "/", omittingEmptySubsequences: false) {
      if segment.isEmpty || segment == "." { continue }
      if segment == ".." {
        if segments.isEmpty { throw EscapeError() }
        segments.removeLast()
        continue
      }
      segments.append(segment)
    }
    return segments.joined(separator: "/")
  }

  static func isHidden(_ path: String) -> Bool {
    path.split(separator: "/", omittingEmptySubsequences: false).contains { $0.hasPrefix(".") }
  }

  static func isSidecar(_ path: String) -> Bool {
    path == sidecar || path.hasPrefix(sidecar + "/")
  }

  /// `a/b/c.md` → `["a", "a/b"]`.
  static func ancestors(_ path: String) -> [String] {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count > 1 else { return [] }
    return (1..<parts.count).map { parts[0..<$0].joined(separator: "/") }
  }

  static func basename(_ path: String) -> String {
    path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? path
  }

  /// Extension with the dot (`.md`), or `""`; dotfiles have none.
  static func extname(_ path: String) -> String {
    let base = basename(path)
    guard let dot = base.lastIndex(of: "."), dot != base.startIndex else { return "" }
    return String(base[dot...])
  }

  static func stem(_ path: String) -> String {
    let base = basename(path)
    let ext = extname(base)
    return ext.isEmpty ? base : String(base.dropLast(ext.count))
  }

  static func isMarkdown(_ path: String) -> Bool { extname(path).lowercased() == ".md" }

  static func ensureMarkdownExtension(_ path: String) -> String {
    isMarkdown(path) ? path : path + ".md"
  }

  static func isTextNote(_ path: String) -> Bool {
    textNoteExtensions.contains(extname(path).lowercased())
  }

  /// A visible vault path from user input, or the daemon's 400 `invalid_path`.
  static func resolveVaultPath(_ input: String) throws(DaemonClientError) -> String {
    let path: String
    do {
      path = try normalize(input)
    } catch {
      throw .invalidPath("Invalid vault path \"\(input)\": escapes the vault root")
    }
    if path.isEmpty { throw .invalidPath("Path is empty") }
    if path.utf16.count > 1024 { throw .invalidPath("Path is too long") }
    if path.split(separator: "/").contains(where: { $0.utf16.count > 255 }) {
      throw .invalidPath("A file or folder name is too long")
    }
    if path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) {
      throw .invalidPath("Path contains control characters")
    }
    if isHidden(path) { throw .invalidPath("Hidden files and folders are not accessible") }
    return path
  }

  static func resolveNotePath(_ input: String) throws(DaemonClientError) -> String {
    let path = try resolveVaultPath(input)
    guard isTextNote(path) else {
      let ext = extname(path)
      throw .invalidPath("Not a text note: \"\(ext.isEmpty ? path : ext)\"")
    }
    return path
  }

  /// UTF-8 prefix of `value` of at most `maxBytes` bytes, never splitting a character.
  static func truncateUTF8(_ value: String, maxBytes: Int) -> String {
    guard value.utf8.count > maxBytes else { return value }
    var out = ""
    var bytes = 0
    for character in value {
      bytes += character.utf8.count
      if bytes > maxBytes { break }
      out.append(character)
    }
    return out
  }
}

/// `hashString` of `@ddl/core` (cyrb53 over UTF-16 code units): the content version the daemon's
/// storage providers report, so the fake's versions match the real daemon's for the same text.
enum ContentHash {
  static func version(of text: String) -> String {
    var h1: UInt32 = 0xDEAD_BEEF
    var h2: UInt32 = 0x41C6_CE57
    for unit in text.utf16 {
      let ch = UInt32(unit)
      h1 = (h1 ^ ch) &* 2_654_435_761
      h2 = (h2 ^ ch) &* 1_597_334_677
    }
    h1 = ((h1 ^ (h1 >> 16)) &* 2_246_822_507) ^ ((h2 ^ (h2 >> 13)) &* 3_266_489_909)
    h2 = ((h2 ^ (h2 >> 16)) &* 2_246_822_507) ^ ((h1 ^ (h1 >> 13)) &* 3_266_489_909)
    let hex = String((UInt64(h2 & 0x1F_FFFF) << 32) | UInt64(h1), radix: 16)
    return String(repeating: "0", count: max(0, 14 - hex.count)) + hex
  }
}
