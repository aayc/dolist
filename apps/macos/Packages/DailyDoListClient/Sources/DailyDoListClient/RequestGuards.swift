import DailyDoListModels

/// Checks made before a request leaves, for values URL parsers would silently reinterpret. The
/// daemon's router resolves `.`/`..` path segments (even percent-encoded ones), so such a request
/// would address a different route or note; they fail locally with the 400 the daemon would give.
enum RequestGuards {
  /// `APIRoute.note(path)`, refusing `.`/`..` segments (the daemon never accepts them anyway).
  static func noteRoute(_ path: String) throws(DaemonClientError) -> String {
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    if segments.contains(where: { $0 == "." || $0 == ".." }) {
      throw .invalidPath("Invalid note path \"\(path)\"")
    }
    return APIRoute.note(path)
  }

  /// Runtime ids (threads, approvals, artifacts) as the daemon validates them:
  /// `^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`.
  static func runtimeID(_ id: String, _ what: String) throws(DaemonClientError) -> String {
    guard isRuntimeID(id) else { throw .invalidRequest("Invalid \(what)") }
    return id
  }

  static func isRuntimeID(_ id: String) -> Bool {
    guard (1...200).contains(id.utf8.count), id != ".", id != ".." else { return false }
    return id.utf8.allSatisfy { byte in
      switch byte {
      case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
        UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "_"), UInt8(ascii: "."),
        UInt8(ascii: ":"), UInt8(ascii: "-"):
        true
      default: false
      }
    }
  }

  /// Client ids the daemon accepts for attribution: `^[A-Za-z0-9_-]{1,128}$`.
  static func isClientID(_ id: String) -> Bool {
    guard (1...128).contains(id.utf8.count) else { return false }
    return id.utf8.allSatisfy { byte in
      switch byte {
      case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
        UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "_"), UInt8(ascii: "-"):
        true
      default: false
      }
    }
  }
}
