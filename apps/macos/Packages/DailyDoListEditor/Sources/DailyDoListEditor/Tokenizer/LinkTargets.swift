import Foundation

/// The parts of a wikilink's inner text `target#subpath|alias` (whitespace trimmed).
struct WikiLinkParts: Equatable, Sendable {
  /// Note target without the subpath, e.g. `Daily/2026-06-19`. Empty for `[[#Heading]]`.
  var target: String
  /// `Heading` or `^block` (without the `#`).
  var subpath: String?
  var alias: String?

  init(_ inner: String) {
    let pipe = inner.firstIndex(of: "|")
    let targetText = pipe.map { inner[..<$0] } ?? inner[...]
    let hash = targetText.firstIndex(of: "#")
    target = String(hash.map { targetText[..<$0] } ?? targetText).trimmingCharacters(
      in: .whitespaces)
    let subpath = hash.map { String(targetText[targetText.index(after: $0)...]) }?
      .trimmingCharacters(in: .whitespaces)
    self.subpath = subpath?.isEmpty == false ? subpath : nil
    let alias = pipe.map { String(inner[inner.index(after: $0)...]) }?.trimmingCharacters(
      in: .whitespaces)
    self.alias = alias?.isEmpty == false ? alias : nil
  }
}

/// Where following a link leads.
enum LinkDestination: Equatable, Sendable {
  /// An `http(s)`, `mailto` or `tel` URL (`www.` gets `https://`, bare emails `mailto:`).
  case external(URL)
  /// A note in the vault: wikilinks and scheme-less markdown destinations (`[x](Daily/2026.md)`).
  case note(target: String, subpath: String?)
}

enum LinkClassifier {
  private static let safeSchemes: Set<String> = ["http", "https", "mailto", "tel"]

  /// Resolves a link target. Unsafe schemes (`javascript:`, `file:`, `data:`, …) resolve to nil
  /// and are never handed to the host.
  static func destination(for target: LinkTarget) -> LinkDestination? {
    switch target {
    case .wiki(let target, let subpath, _, _):
      return target.isEmpty ? nil : .note(target: target, subpath: subpath)
    case .url(let raw):
      return classify(raw)
    }
  }

  static func classify(_ raw: String) -> LinkDestination? {
    var url = raw.trimmingCharacters(in: .whitespaces)
    if url.hasPrefix("<"), url.hasSuffix(">"), url.count >= 2 {
      url = String(url.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
    }
    guard !url.isEmpty else { return nil }
    if let scheme = scheme(of: url) {
      guard safeSchemes.contains(scheme.lowercased()) else { return nil }
      return external(url)
    }
    if url.lowercased().hasPrefix("www.") { return external("https://" + url) }
    if url.hasPrefix("//") { return external("https:" + url) }
    if isEmail(url) { return external("mailto:" + url) }
    let hash = url.firstIndex(of: "#")
    let target = decode(String(hash.map { url[..<$0] } ?? url[...]))
    let subpath = hash.map { decode(String(url[url.index(after: $0)...])) }
    guard !target.isEmpty else { return nil }
    return .note(target: target, subpath: subpath?.isEmpty == false ? subpath : nil)
  }

  private static func external(_ string: String) -> LinkDestination? {
    if let url = URL(string: string) { return .external(url) }
    let escaped = string.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed)
    return escaped.flatMap(URL.init(string:)).map(LinkDestination.external)
  }

  /// `scheme:` per RFC 3986 (a letter, then letters, digits, `+`, `.`, `-`).
  private static func scheme(of url: String) -> String? {
    guard let colon = url.firstIndex(of: ":") else { return nil }
    let candidate = url[..<colon]
    guard let first = candidate.unicodeScalars.first, first.isASCII, first.properties.isAlphabetic,
      candidate.unicodeScalars.allSatisfy({
        $0.isASCII
          && ($0.properties.isAlphabetic || ("0"..."9").contains($0)
            || "+.-".unicodeScalars.contains($0))
      })
    else { return nil }
    return String(candidate)
  }

  private static func isEmail(_ url: String) -> Bool {
    let parts = url.split(separator: "@", omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, parts[1].contains("."),
      !url.contains(where: { $0.isWhitespace || $0 == "/" })
    else { return false }
    let domainParts = parts[1].split(separator: ".", omittingEmptySubsequences: false)
    return domainParts.allSatisfy { !$0.isEmpty }
  }

  private static func decode(_ text: String) -> String {
    text.removingPercentEncoding ?? text
  }
}
