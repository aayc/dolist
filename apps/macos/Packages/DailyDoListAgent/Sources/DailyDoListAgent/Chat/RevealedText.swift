import Foundation
import Observation

/// One agent message typing out: the text that arrived (`target`) and the prefix on screen.
///
/// It counts and cuts by grapheme clusters (`Character`s), so an emoji or a combining sequence
/// never splits. More text arriving extends the target; a final text that isn't an extension (a
/// rewrite) keeps whatever prefix both share and types on from there. Once caught up and no longer
/// streaming, `visible` is exactly the final text.
@MainActor
@Observable
final class RevealedText {
  /// The revealed prefix.
  private(set) var visible: String
  /// Behind what arrived, or the message still streams: the caret shows.
  private(set) var isActive: Bool

  /// Everything received so far.
  @ObservationIgnored private(set) var target: String
  @ObservationIgnored private(set) var isStreaming: Bool
  /// Characters of `target` not shown yet.
  @ObservationIgnored private(set) var backlog: Int
  /// Where `visible` ends in `target` (always a `Character` boundary).
  @ObservationIgnored private var end: String.Index

  /// - Parameter revealed: start with all of `text` shown (it was already on screen).
  init(text: String, streaming: Bool, revealed: Bool) {
    target = text
    isStreaming = streaming
    end = revealed ? text.endIndex : text.startIndex
    backlog = revealed ? 0 : text.count
    visible = revealed ? text : ""
    isActive = streaming || (!revealed && !text.isEmpty)
  }

  /// Nothing left to type (it may still stream).
  var isCaughtUp: Bool { backlog == 0 }

  /// The message changed: more text arrived, it finished, or it was rewritten.
  func update(text: String, streaming: Bool) {
    isStreaming = streaming
    if text.utf8.count != target.utf8.count || text != target {
      let shownBytes = target.utf8.distance(from: target.startIndex, to: end)
      let keptBytes =
        text.utf8.starts(with: target.utf8)
        ? shownBytes : min(shownBytes, Self.commonPrefixBytes(target, text))
      target = text
      end = Self.characterBoundary(in: text, atOrBeforeUTF8Offset: keptBytes)
      backlog = text[end...].count
      let prefix = String(text[..<end])
      if prefix != visible { visible = prefix }
    }
    refreshActive()
  }

  /// One frame, `elapsed` seconds after the previous one. Returns whether text is still behind.
  @discardableResult
  func advance(by elapsed: TimeInterval) -> Bool {
    let count = RevealPacing.step(backlog: backlog, elapsed: elapsed)
    if count > 0 {
      end = target.index(end, offsetBy: count)
      backlog -= count
      visible = String(target[..<end])
    }
    refreshActive()
    return backlog > 0
  }

  /// Shows everything that arrived (Reduce Motion turned on, the chat closing).
  func finish() {
    guard backlog > 0 else { return }
    end = target.endIndex
    backlog = 0
    visible = target
    refreshActive()
  }

  private func refreshActive() {
    let active = isStreaming || backlog > 0
    if active != isActive { isActive = active }
  }

  /// Bytes both strings start with.
  static func commonPrefixBytes(_ a: String, _ b: String) -> Int {
    var count = 0
    for (x, y) in zip(a.utf8, b.utf8) {
      guard x == y else { break }
      count += 1
    }
    return count
  }

  /// The last `Character` boundary of `text` at or before a UTF-8 offset: text appended after a
  /// base character can join its cluster (a combining accent, a skin tone), which moves the
  /// boundary back to that character's start.
  static func characterBoundary(in text: String, atOrBeforeUTF8Offset offset: Int) -> String.Index {
    var index = text.utf8.index(text.startIndex, offsetBy: min(max(0, offset), text.utf8.count))
    while index > text.startIndex, String.Index(index, within: text) == nil {
      index = text.utf8.index(before: index)
    }
    return index
  }
}
