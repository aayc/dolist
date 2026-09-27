/// Semantic color of a status, risk or result; each platform supplies its palette.
public enum Tone: String, CaseIterable, Hashable, Sendable {
  case accent, faint, info, warning, success, danger
}
