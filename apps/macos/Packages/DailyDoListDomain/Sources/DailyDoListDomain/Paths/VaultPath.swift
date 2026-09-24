import Foundation

/// A path that can't be a vault path: it contains NUL or climbs above the vault root. Mirrors
/// `InvalidPathError` in @ddl/core.
public struct InvalidPathError: Error, Hashable, Sendable, CustomStringConvertible {
  public enum Reason: String, Hashable, Sendable {
    case nulByte = "contains a NUL byte"
    case escapesRoot = "escapes the vault root"
  }

  public let path: String
  public let reason: Reason

  public init(path: String, reason: Reason) {
    self.path = path
    self.reason = reason
  }

  public var description: String { "Invalid vault path \"\(path)\": \(reason.rawValue)" }
}

/// Vault-relative path helpers (port of @ddl/core `paths.ts`). Vault paths are POSIX-style,
/// relative to the vault root, with no leading slash and no `.`/`..` segments
/// (`Daily/2026-09-23.md`). Separators and dots are ASCII, so everything works on bytes and a
/// combining mark after a `/` never hides it (Swift's `Character` view would).
public enum VaultPath {
  /// Hidden sidecar directory inside the vault that holds agent threads, artifacts and state.
  public static let sidecarDirectory = ".daily-do-list"

  /// `normalizePath`: canonical vault form (`\` → `/`, empty and `.` segments dropped, `..` pops).
  /// Throws when the path contains NUL or escapes the vault root.
  public static func validated(_ path: String) throws(InvalidPathError) -> String {
    if path.utf8.contains(0) { throw InvalidPathError(path: path, reason: .nulByte) }
    guard let segments = segments(path, clampAtRoot: false) else {
      throw InvalidPathError(path: path, reason: .escapesRoot)
    }
    return segments
  }

  /// Canonical vault form that never fails: identical to `validated(_:)` for every valid path;
  /// a `..` above the root is dropped instead of throwing (and NUL is kept).
  public static func normalize(_ path: String) -> String {
    segments(path, clampAtRoot: true) ?? ""
  }

  /// `isSafeVaultPath`: normalizes cleanly to a non-empty path inside the vault.
  public static func isSafe(_ path: String) -> Bool {
    ((try? validated(path)) ?? "").isEmpty == false
  }

  /// Joins non-empty parts and normalizes leniently (see `normalize(_:)`).
  public static func join(_ parts: String...) -> String {
    join(parts)
  }

  public static func join(_ parts: [String]) -> String {
    normalize(parts.filter { !$0.isEmpty }.joined(separator: "/"))
  }

  /// `joinPath`: joins non-empty parts and normalizes; throws like `validated(_:)`.
  public static func validatedJoin(_ parts: String...) throws(InvalidPathError) -> String {
    try validatedJoin(parts)
  }

  public static func validatedJoin(_ parts: [String]) throws(InvalidPathError) -> String {
    try validated(parts.filter { !$0.isEmpty }.joined(separator: "/"))
  }

  /// Everything before the last `/` (`""` for a top-level path).
  public static func dirname(_ path: String) -> String {
    guard let slash = lastIndex(of: 0x2F, in: path) else { return "" }
    return String(decoding: path.utf8.prefix(slash), as: UTF8.self)
  }

  /// Everything after the last `/`.
  public static func basename(_ path: String) -> String {
    guard let slash = lastIndex(of: 0x2F, in: path) else { return path }
    return String(decoding: path.utf8.dropFirst(slash + 1), as: UTF8.self)
  }

  /// Extension including the dot (`.md`), or `""`. Dotfiles like `.env` have no extension; a
  /// trailing dot is an extension of its own (`a.` → `.`).
  public static func extname(_ path: String) -> String {
    let base = basename(path)
    guard let dot = lastIndex(of: 0x2E, in: base), dot > 0 else { return "" }
    return String(decoding: base.utf8.dropFirst(dot), as: UTF8.self)
  }

  /// File name without extension: `Daily/2026-09-23.md` → `2026-09-23`.
  public static func stem(_ path: String) -> String {
    let base = basename(path)
    let ext = extname(base)
    return ext.isEmpty ? base : String(decoding: base.utf8.dropLast(ext.utf8.count), as: UTF8.self)
  }

  /// `isMarkdownPath`: the extension is `.md`, in any case.
  public static func isMarkdown(_ path: String) -> Bool {
    let ext = Array(extname(path).utf8)
    return ext.count == 3 && ext[0] == 0x2E && ext[1] | 0x20 == 0x6D && ext[2] | 0x20 == 0x64
  }

  public static func ensureMarkdownExtension(_ path: String) -> String {
    isMarkdown(path) ? path : "\(path).md"
  }

  /// `isHiddenPath`: some segment is a dotfile or dotfolder (`.obsidian`, `.git`, the sidecar…).
  public static func isHidden(_ path: String) -> Bool {
    var atSegmentStart = true
    for byte in path.utf8 {
      if atSegmentStart && byte == 0x2E { return true }
      atSegmentStart = byte == 0x2F
    }
    return false
  }

  /// `isSidecarPath`: the sidecar directory or anything inside it.
  public static func isSidecar(_ path: String) -> Bool {
    path.jsEquals(sidecarDirectory) || path.jsHasPrefix("\(sidecarDirectory)/")
  }

  /// `ancestorFolders`: every ancestor folder, outermost first (`a/b/c.md` → `a`, `a/b`).
  public static func ancestorFolders(_ path: String) -> [String] {
    var out: [String] = []
    for (i, byte) in path.utf8.enumerated() where byte == 0x2F {
      out.append(String(decoding: path.utf8.prefix(i), as: UTF8.self))
    }
    return out
  }

  /// `compareVaultPaths`: Obsidian's explorer order, a case- and accent-insensitive natural sort
  /// (`Day 2` < `Day 10`), as ICU collates in JavaScript's `localeCompare(…, { numeric: true,
  /// sensitivity: "base" })`. Returns -1, 0 or 1; names equal to the collator compare as 0.
  public static func compare(_ a: String, _ b: String, locale: Locale = .current) -> Int {
    // ICU treats ß as "ss" at this strength; Foundation's collation doesn't, so fold it first.
    let result = foldSharpS(a).compare(
      foldSharpS(b), options: [.caseInsensitive, .diacriticInsensitive, .numeric], range: nil,
      locale: locale)
    switch result {
    case .orderedAscending: return -1
    case .orderedSame: return 0
    case .orderedDescending: return 1
    }
  }

  // MARK: - Private

  private static func foldSharpS(_ text: String) -> String {
    guard text.unicodeScalars.contains(where: { $0 == "ß" || $0 == "ẞ" }) else { return text }
    return String(
      String.UnicodeScalarView(
        text.unicodeScalars.flatMap { scalar -> [Unicode.Scalar] in
          scalar == "ß" || scalar == "ẞ" ? ["s", "s"] : [scalar]
        }))
  }

  /// Splits on `/` and `\`, resolves `.` and `..`; nil if `..` escapes and clamping is off.
  private static func segments(_ path: String, clampAtRoot: Bool) -> String? {
    var kept: [ArraySlice<UInt8>] = []
    let bytes = Array(path.utf8)
    var start = 0
    var i = 0
    while i <= bytes.count {
      if i == bytes.count || bytes[i] == 0x2F || bytes[i] == 0x5C {
        let segment = bytes[start..<i]
        if segment.elementsEqual([0x2E, 0x2E]) {
          if kept.isEmpty {
            if !clampAtRoot { return nil }
          } else {
            kept.removeLast()
          }
        } else if !segment.isEmpty && !segment.elementsEqual([0x2E]) {
          kept.append(segment)
        }
        start = i + 1
      }
      i += 1
    }
    var out: [UInt8] = []
    out.reserveCapacity(bytes.count)
    for (index, segment) in kept.enumerated() {
      if index > 0 { out.append(0x2F) }
      out.append(contentsOf: segment)
    }
    return String(decoding: out, as: UTF8.self)
  }

  private static func lastIndex(of byte: UInt8, in text: String) -> Int? {
    var last: Int?
    for (i, b) in text.utf8.enumerated() where b == byte { last = i }
    return last
  }
}
