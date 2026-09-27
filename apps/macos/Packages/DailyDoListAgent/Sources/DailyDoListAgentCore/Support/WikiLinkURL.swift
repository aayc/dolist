import Foundation

/// `[[wikilinks]]` in agent text become links with this scheme; they never leave the app.
package enum WikiLinkURL {
  package static let scheme = "ddl-note"

  /// A link to the note `target` (it may carry a `#heading`).
  package static func url(for target: String) -> URL? {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "#?/")
    return target.addingPercentEncoding(withAllowedCharacters: allowed).flatMap {
      URL(string: "\(scheme):\($0)")
    }
  }

  /// The note a wikilink URL names.
  package static func target(of url: URL) -> String? {
    guard url.scheme == scheme else { return nil }
    let encoded = url.absoluteString.dropFirst(scheme.count + 1)
    return String(encoded).removingPercentEncoding.flatMap { $0.isEmpty ? nil : $0 }
  }

  /// `Note`, `Note#Heading` → the name shown for the note.
  package static func noteName(_ target: String) -> String {
    let name = target.split(separator: "#", maxSplits: 1).first.map(String.init) ?? target
    let last = name.split(separator: "/").last.map(String.init) ?? name
    return last.hasSuffix(".md") ? String(last.dropLast(3)) : last
  }
}
