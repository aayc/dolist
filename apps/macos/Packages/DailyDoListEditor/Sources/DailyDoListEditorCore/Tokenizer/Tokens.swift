import Foundation

/// Kinds of syntax markers. Live preview hides markers of every kind on lines away from the
/// selection; `task` and `bullet` markers are instead *replaced* (by a checkbox or a dot) and are
/// revealed only while the selection touches the marker itself. An `agent` marker is replaced by a
/// sparkle and revealed with its line.
package enum MarkerKind: Int, Sendable, CaseIterable {
  case heading = 1
  case quote
  case emphasis
  case strikethrough
  case highlight
  case code
  case link
  case wikilink
  case autolink
  case escape
  case horizontalRule
  case task
  case bullet
  case agent
  /// A whole line that is one drawing embed (`![[Plan.excalidraw|360|right-wrap]]`): the drawing
  /// is drawn instead while the line is hidden. Last, so it wins over the link's own markers.
  case embed

  /// Drawn as something else (checkbox, dot, sparkle) in a fixed-width slot instead of just
  /// disappearing.
  package var isReplacement: Bool { self == .task || self == .bullet || self == .agent }

  /// Revealed only while the selection touches the marker itself (the checkbox stays while you
  /// type the task); every other kind is revealed with its line.
  package var revealsOnTouch: Bool { self == .task || self == .bullet }
}

/// Inline (and line-level) styles a tokenizer span can carry. Spans may nest; the highlighter
/// combines overlapping spans.
package struct InlineStyle: OptionSet, Hashable, Sendable {
  package let rawValue: UInt16
  package init(rawValue: UInt16) { self.rawValue = rawValue }

  package static let bold = InlineStyle(rawValue: 1 << 0)
  package static let italic = InlineStyle(rawValue: 1 << 1)
  package static let strikethrough = InlineStyle(rawValue: 1 << 2)
  package static let highlight = InlineStyle(rawValue: 1 << 3)
  package static let code = InlineStyle(rawValue: 1 << 4)
  /// Markdown link text, autolinks and bare URLs.
  package static let link = InlineStyle(rawValue: 1 << 5)
  package static let wikilink = InlineStyle(rawValue: 1 << 6)
  package static let tag = InlineStyle(rawValue: 1 << 7)
  /// Text of a completed (`[x]`) task.
  package static let taskDone = InlineStyle(rawValue: 1 << 8)
  /// Text of a cancelled (`[-]`) task.
  package static let taskCancelled = InlineStyle(rawValue: 1 << 9)
  /// The number of an ordered list item (`1.`), which stays visible.
  package static let listNumber = InlineStyle(rawValue: 1 << 10)
  /// A line the agent wrote (before its marker).
  package static let agent = InlineStyle(rawValue: 1 << 11)
}

package struct StyledSpan: Equatable, Sendable {
  package var range: NSRange
  package var style: InlineStyle
}

package struct SyntaxMarker: Equatable, Sendable {
  package var range: NSRange
  package var kind: MarkerKind
}

/// What a link points to, as written in the text.
package enum LinkTarget: Hashable, Sendable {
  /// `[[target#subpath|alias]]` or `![[embed]]`; `target` excludes the subpath and alias.
  case wiki(target: String, subpath: String?, alias: String?, isEmbed: Bool)
  /// Destination of a markdown link, an autolink or a bare URL (classified when clicked).
  case url(String)
}

package struct LinkToken: Equatable, Sendable {
  /// The whole link including its syntax.
  package var range: NSRange
  package var target: LinkTarget
}

package struct TaskToken: Equatable, Sendable {
  /// Replaced by the checkbox: `- [ ]` in bullet lists, just `[ ]` in ordered lists.
  package var markerRange: NSRange
  /// The `[ ]` box.
  package var boxRange: NSRange
  /// The UTF-16 unit between the brackets (`" "`, `"x"`, `"/"`, `"-"`, `">"`, …).
  package var status: UInt16
  /// Task text after the box and its following whitespace (possibly empty).
  package var textRange: NSRange
}

package struct TagToken: Equatable, Sendable {
  package var range: NSRange
  /// Tag name without the `#`.
  package var name: String
}

package enum LineKind: Equatable, Sendable {
  case blank
  case paragraph
  case heading(level: Int)
  case listItem
  case horizontalRule
  case codeFenceOpen
  case codeFenceClose
  case code
  case frontmatterDelimiter
  case frontmatter

  /// Lines whose content is literal (no inline markdown, no list editing).
  package var isLiteral: Bool {
    switch self {
    case .codeFenceOpen, .codeFenceClose, .code, .frontmatterDelimiter, .frontmatter: true
    default: false
    }
  }
}

/// Block context entering a line: inside a fenced code block or not. (Frontmatter is decided for
/// the whole document up front; see `MarkdownTokenizer.frontmatterEnd`.)
package enum BlockState: Hashable, Sendable {
  case normal
  case fence(marker: UInt16, length: Int)
}

/// Role of a line inside YAML frontmatter.
package enum FrontmatterRole: Sendable {
  case delimiter
  case content
}

/// Where the parts of a list item's prefix are (UTF-16 offsets, like the other token ranges), for
/// aligning wrapped lines with the item's text.
package struct ListPrefixLayout: Equatable, Sendable {
  /// Start of the indentation after any blockquote markers.
  package var indentStart: Int
  package var markerStart: Int
  package var markerEnd: Int
  /// The task box, if any.
  package var box: NSRange?
  /// Where the item's text starts.
  package var textStart: Int

  package func offset(by delta: Int) -> ListPrefixLayout {
    ListPrefixLayout(
      indentStart: indentStart + delta, markerStart: markerStart + delta,
      markerEnd: markerEnd + delta,
      box: box?.shifted(by: delta), textStart: textStart + delta)
  }
}

/// Tokens of one line. Ranges are in UTF-16 units relative to the line start unless the value was
/// produced by `MarkdownTokenizer.tokenize(_:)`, which returns document offsets.
package struct LineTokens: Equatable, Sendable {
  package var kind: LineKind
  package var quoteDepth = 0
  package var spans: [StyledSpan] = []
  package var markers: [SyntaxMarker] = []
  package var links: [LinkToken] = []
  package var tags: [TagToken] = []
  package var task: TaskToken?
  /// The list marker (`-`, `*`, `+`, `1.`, `1)`) of a list item.
  package var listMarker: NSRange?
  package var listPrefix: ListPrefixLayout?
  /// The agent marker ending the line, when the agent wrote it.
  package var agent: AgentMarkerToken?
  /// The `![[…]]` of a drawing embed alone on its line (spaces aside).
  package var embed: NSRange?

  package init(kind: LineKind) {
    self.kind = kind
  }

  /// The same tokens with every range moved by `delta`.
  package func offset(by delta: Int) -> LineTokens {
    guard delta != 0 else { return self }
    var copy = self
    copy.spans = spans.map { StyledSpan(range: $0.range.shifted(by: delta), style: $0.style) }
    copy.markers = markers.map { SyntaxMarker(range: $0.range.shifted(by: delta), kind: $0.kind) }
    copy.links = links.map { LinkToken(range: $0.range.shifted(by: delta), target: $0.target) }
    copy.tags = tags.map { TagToken(range: $0.range.shifted(by: delta), name: $0.name) }
    copy.task = task.map {
      TaskToken(
        markerRange: $0.markerRange.shifted(by: delta), boxRange: $0.boxRange.shifted(by: delta),
        status: $0.status, textRange: $0.textRange.shifted(by: delta))
    }
    copy.listMarker = listMarker?.shifted(by: delta)
    copy.listPrefix = listPrefix?.offset(by: delta)
    copy.agent = agent?.offset(by: delta)
    copy.embed = embed?.shifted(by: delta)
    return copy
  }
}

extension NSRange {
  @inline(__always) package init(_ start: Int, _ end: Int) {
    self.init(location: start, length: max(0, end - start))
  }

  @inline(__always) package var end: Int { location + length }

  @inline(__always) package func shifted(by delta: Int) -> NSRange {
    NSRange(location: location + delta, length: length)
  }

  /// True when the ranges overlap or touch (`[a, b]` and `[c, d]` with `a <= d && c <= b`).
  @inline(__always) package func touches(_ other: NSRange) -> Bool {
    location <= other.end && other.location <= end
  }
}
