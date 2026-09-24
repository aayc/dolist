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

/// Deterministic RNG (SplitMix64) for property tests; reproduce failures with the printed seed.
struct SeededGenerator: RandomNumberGenerator {
  private var state: UInt64

  init(seed: UInt64) {
    state = seed
  }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
