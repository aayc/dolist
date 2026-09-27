import Foundation

/// The host resolves backlinks using its vault index/cache. Line numbers remain zero-based.
public struct EditorBacklinkMention: Identifiable, Hashable, Sendable {
  public enum Kind: String, Sendable { case linked, unlinked }
  public var path: String
  public var line: Int
  public var context: String
  public var kind: Kind
  public var id: String { "\(kind.rawValue):\(path):\(line)" }
  public init(path: String, line: Int, context: String, kind: Kind) {
    self.path = path
    self.line = max(0, line)
    self.context = context
    self.kind = kind
  }
}

public struct EditorBacklinksSnapshot: Equatable, Sendable {
  public enum Coverage: Equatable, Sendable {
    case complete
    /// Cache/search coverage is incomplete; an empty result does not claim no mentions exist.
    case partial
    case cached(updatedAt: Date?)
  }
  public var mentions: [EditorBacklinkMention]
  public var coverage: Coverage
  public init(mentions: [EditorBacklinkMention], coverage: Coverage = .complete) {
    self.mentions = mentions
    self.coverage = coverage
  }
}
