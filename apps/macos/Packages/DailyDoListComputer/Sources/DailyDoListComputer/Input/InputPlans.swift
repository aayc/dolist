import Foundation

/// One step of typing text: a chunk of text carried by a key event, or a key press.
public enum TypingStep: Equatable, Sendable {
  case text(String)
  case key(UInt16)
}

/// Text → typing steps: unicode chunks of at most `maxChunk` UTF-16 units (the most one key event
/// carries), never splitting a character; each line break (`\n`, `\r\n` or `\r`) presses Return
/// once and a tab presses Tab, which apps handle better than literal control characters.
public enum TypingPlan {
  public static let maxChunk = 20
  static let returnKey: UInt16 = 36
  static let tabKey: UInt16 = 48

  public static func steps(for text: String, maxChunk: Int = maxChunk) -> [TypingStep] {
    var steps: [TypingStep] = []
    var chunk = ""
    func flush() {
      if !chunk.isEmpty { steps.append(.text(chunk)) }
      chunk = ""
    }
    for character in text {
      switch character {
      case "\n", "\r\n", "\r":
        flush()
        steps.append(.key(returnKey))
      case "\t":
        flush()
        steps.append(.key(tabKey))
      default:
        let length = character.utf16.count
        if length > maxChunk {
          // A character longer than one event (a long emoji sequence): split between scalars.
          flush()
          for scalar in character.unicodeScalars {
            if chunk.utf16.count + scalar.utf16.count > maxChunk { flush() }
            chunk.unicodeScalars.append(scalar)
          }
          flush()
        } else {
          if chunk.utf16.count + length > maxChunk { flush() }
          chunk.append(character)
        }
      }
    }
    flush()
    return steps
  }
}

/// A scroll in lines (positive `dy` = down, positive `dx` = right) → wheel events of at most
/// `maxLinesPerEvent` lines each (bigger deltas misbehave). Wheel deltas are positive for up and
/// left, hence the sign flip. A port of `scrollSteps` in `computer-geometry.ts`.
public enum ScrollPlan {
  public static let maxLines = 200
  public static let maxLinesPerEvent = 10

  public static func steps(dx: Int, dy: Int) -> [(dx: Int32, dy: Int32)] {
    func clampTotal(_ value: Int) -> Int { max(-maxLines, min(maxLines, value)) }
    func clampStep(_ value: Int) -> Int { max(-maxLinesPerEvent, min(maxLinesPerEvent, value)) }
    var restX = -clampTotal(dx)
    var restY = -clampTotal(dy)
    var steps: [(dx: Int32, dy: Int32)] = []
    while restX != 0 || restY != 0 {
      let stepX = clampStep(restX)
      let stepY = clampStep(restY)
      steps.append((Int32(stepX), Int32(stepY)))
      restX -= stepX
      restY -= stepY
    }
    return steps
  }
}
