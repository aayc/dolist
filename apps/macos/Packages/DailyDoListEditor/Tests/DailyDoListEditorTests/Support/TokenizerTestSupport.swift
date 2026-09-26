import Foundation

@testable import DailyDoListEditor

/// Tokenizes a single line (outside any fence or frontmatter).
func tokenizeLine(_ line: String) -> LineTokens {
  MarkdownTokenizer.tokenizeLine(Array(line.utf16), state: .normal).tokens
}

func substring(_ text: String, _ range: NSRange) -> String {
  (text as NSString).substring(with: range)
}

/// Substrings covered by spans of exactly `style`, in document order.
func spans(_ line: String, _ style: InlineStyle) -> [String] {
  tokenizeLine(line).spans
    .filter { $0.style == style }
    .sorted { $0.range.location < $1.range.location }
    .map { substring(line, $0.range) }
}

/// Substrings of markers (optionally of one kind), in document order.
func markers(_ line: String, _ kind: MarkerKind? = nil) -> [String] {
  tokenizeLine(line).markers
    .filter { kind == nil || $0.kind == kind }
    .sorted { $0.range.location < $1.range.location }
    .map { substring(line, $0.range) }
}

func linkTargets(_ line: String) -> [LinkTarget] {
  tokenizeLine(line).links.map(\.target)
}

func tagNames(_ line: String) -> [String] {
  tokenizeLine(line).tags.map(\.name)
}

/// Line kinds of a whole document.
func lineKinds(_ text: String) -> [LineKind] {
  MarkdownTokenizer.tokenize(text).map(\.tokens.kind)
}
