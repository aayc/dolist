import Foundation

enum WorkspaceDocumentPath {
  static func isDrawing(_ path: String) -> Bool { path.hasSuffix(".excalidraw.md") }

  static func validate(_ path: String) throws {
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    guard !path.isEmpty, path.hasSuffix(".md"), !path.contains("\\"), !path.contains("\0"),
      segments.allSatisfy({ !$0.isEmpty && !$0.hasPrefix(".") })
    else { throw WorkspaceRepositoryError.invalidPath }
  }
}
