import DailyDoListDrawingModel
import Foundation

/// A drawing embed alone on its line, as the document has it now.
package struct EmbedLine: Equatable {
  /// 0-based.
  package var line: Int
  /// The line's content (without its `\n`); its start is the embed's anchor.
  package var content: NSRange
  package var spec: DrawingEmbed

  package init(line: Int, content: NSRange, spec: DrawingEmbed) {
    self.line = line
    self.content = content
    self.spec = spec
  }

  package var lineStart: Int { content.location }
}
