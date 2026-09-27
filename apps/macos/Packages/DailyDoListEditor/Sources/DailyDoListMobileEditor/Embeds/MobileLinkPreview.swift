#if canImport(UIKit)
  import DailyDoListDomain
  import DailyDoListEditorCore
  import UIKit

  extension MobileMarkdownController {
    /// Builds a local request containing the visible label and original authoring thread.
    /// The host may read saved thread sources or a cached note; the editor never fetches a URL.
    public func linkPreview(atUTF16 offset: Int) -> EditorLinkPreview? {
      let storage = input.textStorage.mutableString
      guard offset >= 0, offset < storage.length else { return nil }
      let line = parser.lineIndex.line(containing: offset)
      guard !parser.isLiteralLine(line) else { return nil }
      let range = parser.lineIndex.contentRange(ofLine: line, textLength: storage.length)
      let units = storage.utf16Units(in: range)
      let (tokens, _) = MarkdownTokenizer.tokenizeLine(units, state: parser.lines[line].entry)
      guard
        let link = tokens.links.first(where: {
          NSLocationInRange(offset - range.location, $0.range)
        })
      else { return nil }
      let target: EditorLinkPreview.Target
      if case .wiki(let path, let subpath, _, _) = link.target, path.isEmpty, subpath != nil {
        target = .note(target: "", subpath: subpath)
      } else {
        guard let destination = LinkClassifier.destination(for: link.target) else { return nil }
        switch destination {
        case .external(let url): target = .external(url)
        case .note(let path, let subpath):
          guard !path.hasPrefix("/") else { return nil }
          target = .note(target: path, subpath: subpath)
        }
      }
      let hidden = tokens.markers.map(\.range)
      let visible = link.range.location..<link.range.end
      let label = String(
        decoding: visible.compactMap { index in
          hidden.contains(where: { NSLocationInRange(index, $0) }) ? nil : units[index]
        }, as: UTF16.self
      ).trimmingCharacters(in: .whitespaces)
      return EditorLinkPreview(
        target: target, label: label,
        agentThreadId: AgentMarker.scan(units)?.threadId)
    }
  }
#endif
