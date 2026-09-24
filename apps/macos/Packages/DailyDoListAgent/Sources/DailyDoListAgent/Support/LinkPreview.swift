import DailyDoListModels
import Foundation

/// The hover preview of an external link: what a thread's `sources` say about the page, else the
/// link itself. Never built by fetching the page (privacy and SSRF).
public struct LinkPreview: Hashable, Sendable {
  /// The source's title, else the link text, else the hostname.
  public var title: String
  /// The hostname without `www.`.
  public var host: String
  public var snippet: String?
  /// The full URL.
  public var url: String

  public init(title: String, host: String, snippet: String? = nil, url: String) {
    self.title = title
    self.host = host
    self.snippet = snippet
    self.url = url
  }

  /// The preview of `url`, linked as `label`, from the page among `sources` (matched ignoring a
  /// `www.`, a trailing slash, the fragment and http vs https).
  public static func make(url: String, label: String?, sources: [CitedSource]) -> LinkPreview {
    let parsed = URL(string: url)
    var host = parsed?.host(percentEncoded: false) ?? ""
    if host.lowercased().hasPrefix("www.") { host = String(host.dropFirst(4)) }
    let source = CitedSourceMatch.source(for: url, in: sources)
    let text = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let meaningfulLabel = text.isEmpty || isCitationLabel(text) || text == url ? nil : text
    let title = source?.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
      ?? meaningfulLabel ?? (host.isEmpty ? url : host)
    let snippet = source?.snippet?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
    return LinkPreview(title: title, host: host, snippet: snippet, url: url)
  }

  /// The preview as plain text (a tooltip): title, hostname, snippet, URL.
  public var text: String {
    var lines = [title]
    if !host.isEmpty, host != title { lines.append(host) }
    if let snippet { lines.append(snippet) }
    if url != title { lines.append(url) }
    return lines.joined(separator: "\n")
  }

  /// A citation's label: just a number (`[1](url)`, `[12](url)`).
  public static func isCitationLabel(_ label: String) -> Bool {
    (1...3).contains(label.count) && label.allSatisfy { $0.isASCII && $0.isNumber }
  }
}

/// The hover preview of a `[[wikilink]]`: the note's name and its first non-empty lines.
public struct NotePreview: Hashable, Sendable {
  public var title: String
  public var lines: [String]

  public init(title: String, lines: [String]) {
    self.title = title
    self.lines = lines
  }

  /// The preview as plain text (a tooltip).
  public var text: String {
    ([title] + lines).joined(separator: "\n")
  }
}

enum CitedSourceMatch {
  static func source(for url: String, in sources: [CitedSource]) -> CitedSource? {
    if let exact = sources.first(where: { $0.url == url }) { return exact }
    guard let key = key(url) else { return nil }
    return sources.first { self.key($0.url) == key }
  }

  /// `host/path?query`, lowercased host without `www.`, no trailing slash, no fragment.
  static func key(_ url: String) -> String? {
    guard var components = URLComponents(string: url), let host = components.host?.lowercased() else { return nil }
    components.fragment = nil
    var path = components.percentEncodedPath
    while path.hasSuffix("/") { path.removeLast() }
    let query = components.percentEncodedQuery.map { "?\($0)" } ?? ""
    return (host.hasPrefix("www.") ? String(host.dropFirst(4)) : host) + path + query
  }
}

extension String {
  var nilIfBlank: String? { isEmpty ? nil : self }
}
