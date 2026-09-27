import DailyDoListDrawingModel
import Foundation

/// A local image/PDF on its own line. External URLs stay links; loading is always the host's
/// authenticated vault operation, never a URLSession request inferred from note contents.
package struct NoteAttachmentEmbed: Equatable {
  package var spec: DrawingEmbed
  package var markdown: Bool

  package static func isSupportedTarget(_ target: String) -> Bool {
    let decoded = target.removingPercentEncoding ?? target
    guard !decoded.isEmpty, !decoded.hasPrefix("/"), !decoded.hasPrefix("\\"),
      !decoded.contains(":"), !decoded.contains("\n"), !decoded.contains("\r")
    else { return false }
    let ext = (decoded as NSString).pathExtension.lowercased()
    return [
      "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "svg", "pdf",
    ]
    .contains(ext)
  }

  package static func parse(line: String) -> NoteAttachmentEmbed? {
    let source = line.trimmingCharacters(in: .whitespaces)
    if source.hasPrefix("![["), source.hasSuffix("]]"), source.count > 5 {
      let inner = String(source.dropFirst(3).dropLast(2))
      guard !inner.contains("[["), !inner.contains("]]"),
        let spec = DrawingEmbed.parse(inner: inner, isDrawing: true),
        isSupportedTarget(spec.target)
      else { return nil }
      return NoteAttachmentEmbed(spec: spec, markdown: false)
    }
    guard source.hasPrefix("!["), !source.hasPrefix("![[") else { return nil }
    let units = Array(source.utf16)
    var tokens = InlineTokenizer(units, from: 0, to: units.count)
    tokens.run()
    guard tokens.images.count == 1, let link = tokens.images.first,
      link.range.location == 0, link.range.length == units.count,
      case .url(let target) = link.target, isSupportedTarget(target)
    else { return nil }
    return NoteAttachmentEmbed(spec: DrawingEmbed(target: target), markdown: true)
  }
}
