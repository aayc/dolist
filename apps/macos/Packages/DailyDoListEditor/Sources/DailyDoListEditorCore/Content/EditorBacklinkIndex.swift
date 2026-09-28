import DailyDoListDomain
import Foundation

/// On-demand indexing over a bounded host/cache snapshot, never on the editor input path.
public enum EditorBacklinkIndex {
  public static func mentions(of target: String, notes: [String: String], paths: [String])
    -> [EditorBacklinkMention]
  {
    var mentions: [EditorBacklinkMention] = []
    let name = VaultPath.stem(target)
    for path in notes.keys.sorted() where path != target {
      guard let text = notes[path] else { continue }
      let source = text as NSString
      let parser = MarkdownParseCache()
      parser.rebuild(source) { tokens, _, range, _ in
        guard !tokens.kind.isLiteral else { return }
        let line = source.substring(with: range)
        let links = tokens.links
        let linked = links.contains { link in
          let requested: String
          switch link.target {
          case .wiki(let value, _, _, _): requested = value
          case .url(let raw):
            guard URLComponents(string: raw)?.scheme == nil, !raw.hasPrefix("/") else {
              return false
            }
            requested = raw.components(separatedBy: "#")[0].removingPercentEncoding ?? raw
          }
          let folder = path.split(separator: "/").dropLast().joined(separator: "/")
          let relative = folder.isEmpty ? requested : folder + "/" + requested
          let resolved =
            paths.contains(relative) ? relative : WikiLinks.resolve(requested, in: paths)
          return resolved == target
        }
        if linked || containsName(name, in: line) {
          mentions.append(
            EditorBacklinkMention(
              path: path,
              line: parser.lineIndex.line(containing: range.location),
              context: String(line.prefix(800)), kind: linked ? .linked : .unlinked))
        }
      }
    }
    return mentions
  }

  private static func containsName(_ name: String, in line: String) -> Bool {
    guard !name.isEmpty else { return false }
    var remainder = line.startIndex..<line.endIndex
    while let match = line.range(
      of: name, options: [.caseInsensitive, .diacriticInsensitive], range: remainder)
    {
      let left =
        match.lowerBound == line.startIndex
        || !line[line.index(before: match.lowerBound)].isLetter
          && !line[line.index(before: match.lowerBound)].isNumber
      let right =
        match.upperBound == line.endIndex
        || !line[match.upperBound].isLetter && !line[match.upperBound].isNumber
      if left && right { return true }
      remainder = match.upperBound..<line.endIndex
    }
    return false
  }
}
