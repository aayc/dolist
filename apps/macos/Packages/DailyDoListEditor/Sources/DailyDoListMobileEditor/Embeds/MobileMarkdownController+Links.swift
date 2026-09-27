#if canImport(UIKit)
  import DailyDoListDomain
  import DailyDoListEditorCore
  import UIKit

  extension MobileMarkdownController {
    /// Follows a note or allowed external link at a source offset. The host decides navigation.
    @discardableResult
    public func openLink(atUTF16 offset: Int) -> Bool {
      guard let link = link(at: offset), let open = embeds.host?.onOpenLink else { return false }
      open(link.target)
      return true
    }

    func linkAtPoint(_ point: CGPoint) -> Int? {
      guard configuration.livePreview, embeds.host?.onOpenLink != nil else { return nil }
      let location = CGPoint(
        x: point.x - input.textContainerInset.left, y: point.y - input.textContainerInset.top)
      let character = input.layoutManager.characterIndex(
        for: location, in: input.textContainer, fractionOfDistanceBetweenInsertionPoints: nil)
      guard let link = link(at: character), !preview.isLineRevealed(containing: character) else {
        return nil
      }
      let glyphs = input.layoutManager.glyphRange(
        forCharacterRange: link.range, actualCharacterRange: nil)
      let rect = input.layoutManager.boundingRect(forGlyphRange: glyphs, in: input.textContainer)
      return rect.insetBy(dx: 2, dy: 2).contains(location) ? character : nil
    }

    private func link(at offset: Int) -> (target: EditorLinkPreview.Target, range: NSRange)? {
      let storage = input.textStorage.mutableString
      guard offset >= 0, offset < storage.length else { return nil }
      let line = parser.lineIndex.line(containing: offset)
      guard !parser.isLiteralLine(line) else { return nil }
      let range = parser.lineIndex.contentRange(ofLine: line, textLength: storage.length)
      let (tokens, _) = MarkdownTokenizer.tokenizeLine(
        storage.utf16Units(in: range), state: parser.lines[line].entry)
      guard
        let link = tokens.links.first(where: {
          NSLocationInRange(offset - range.location, $0.range)
        })
      else { return nil }
      let target: EditorLinkPreview.Target
      switch link.target {
      case .wiki(let path, let subpath, _, _): target = .note(target: path, subpath: subpath)
      case .url(let raw):
        guard let url = URL(string: raw) else { return nil }
        if url.scheme != nil {
          guard LinkPolicy.isAllowed(url) else { return nil }
          target = .external(url)
        } else {
          guard !raw.hasPrefix("//"), !raw.hasPrefix("/") else { return nil }
          let parts = raw.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)
          target = .note(
            target: String(parts[0]).removingPercentEncoding ?? String(parts[0]),
            subpath: parts.count > 1 ? String(parts[1]) : nil)
        }
      }
      return (target, link.range.shifted(by: range.location))
    }
  }
#endif
