import Foundation

/// A link under the pointer, for its hover preview (the tooltip).
public struct EditorLinkPreview: Hashable, Sendable {
  public enum Target: Hashable, Sendable {
    /// An `http(s)`, `mailto` or `tel` link.
    case external(URL)
    /// A note in the vault: a `[[wikilink]]` or a scheme-less markdown destination.
    case note(target: String, subpath: String?)
  }

  public var target: Target
  /// The link's visible text (a wikilink's alias, a markdown link's label, a bare URL itself).
  public var label: String
  /// The thread named by the agent marker of the link's line, when the agent wrote that line.
  public var agentThreadId: String?

  public init(target: Target, label: String, agentThreadId: String? = nil) {
    self.target = target
    self.label = label
    self.agentThreadId = agentThreadId
  }

  /// What the tooltip shows without the host's help: the link text, hostname and full URL, or
  /// the note's name.
  public var fallbackText: String {
    switch target {
    case .external(let url):
      let full = url.absoluteString
      let host = url.host(percentEncoded: false)
      var lines: [String] = []
      if !label.isEmpty, label != full, label != host { lines.append(label) }
      if let host, !host.isEmpty { lines.append(host) }
      lines.append(full)
      return lines.joined(separator: "\n")
    case .note(let target, let subpath):
      return subpath.map { "\(target) › \($0)" } ?? target
    }
  }
}
