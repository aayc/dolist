import DailyDoListClient
import DailyDoListModels
import Foundation

/// Artifact bytes: kinds, names, text decoding, copy and save.
package enum ArtifactFiles {
  package static func kind(forMimeType mimeType: String) -> ArtifactKind {
    let type =
      mimeType.split(separator: ";").first.map {
        $0.trimmingCharacters(in: .whitespaces).lowercased()
      } ?? ""
    if type.hasPrefix("image/") { return .image }
    switch type {
    case "text/markdown": return .markdown
    case "text/html": return .html
    case "application/json": return .json
    default: return type.hasPrefix("text/") ? .text : .file
    }
  }

  package static func text(of payload: ArtifactPayload) -> String {
    String(data: payload.data, encoding: .utf8) ?? String(decoding: payload.data, as: UTF8.self)
  }

  /// Pretty-printed JSON (keys sorted), or nil when it isn't JSON.
  package static func prettyJSON(_ data: Data) -> String? {
    guard let value = try? JSONDecoder().decode(JSONValue.self, from: data) else { return nil }
    return value.prettyJSONString
  }

  package static func canCopy(_ kind: ArtifactKind) -> Bool { kind != .file }

  /// "Standing desks under $500.md": the title (made safe for a file name) and an extension.
  package static func fileName(meta: ArtifactMeta?, kind: ArtifactKind, mimeType: String) -> String
  {
    let unsafe = CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)
    let base = (meta?.title ?? "artifact").components(separatedBy: unsafe).joined(separator: "-")
      .trimmingCharacters(in: .whitespaces)
    return
      "\(base.isEmpty ? "artifact" : base).\(fileExtension(kind: kind, language: meta?.language, mimeType: mimeType))"
  }

  package static func fileExtension(kind: ArtifactKind, language: String?, mimeType: String)
    -> String
  {
    switch kind {
    case .markdown: return "md"
    case .html: return "html"
    case .json: return "json"
    case .text: return "txt"
    case .image:
      let subtype = mimeType.split(separator: "/").last.map(String.init) ?? "png"
      return subtype == "jpeg" ? "jpg" : subtype.isEmpty ? "png" : subtype
    case .code:
      let known = [
        "python": "py", "javascript": "js", "typescript": "ts", "swift": "swift", "shell": "sh",
        "bash": "sh", "ruby": "rb", "go": "go", "rust": "rs", "java": "java", "css": "css",
        "sql": "sql", "yaml": "yml", "json": "json", "html": "html", "markdown": "md",
      ]
      return language.flatMap { known[$0.lowercased()] } ?? "txt"
    default: return "bin"
    }
  }
}
