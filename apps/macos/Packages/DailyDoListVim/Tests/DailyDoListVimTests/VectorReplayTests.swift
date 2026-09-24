import DailyDoListVim
import DailyDoListVimTestSupport
import Foundation
import Testing

/// Replays every case of the web app's vim vectors (`packages/editor/test/vim/vectors.jsonl`)
/// against `VimTextBuffer`, so the Swift port behaves exactly like the web app's engine. The replay
/// (`DailyDoListVimTestSupport`) is the one the Mac editor's tests run through the real editor.
///
/// `VIM_VECTORS_FILTER` replays the cases whose name contains it; `VIM_VECTORS_VERBOSE=1` records
/// every mismatch instead of the first few per category.
@MainActor
@Suite struct VectorReplayTests {
  /// Cases that are not replayed, with the reason. Keep this list short and justified.
  static let exclusions: [String: String] = [:]

  @Test func everyVectorPassesThroughTheReferenceBuffer() throws {
    guard let file = try VimVectorFile.load() else {
      print("vim vectors: \(VimVectorFile.defaultURL.path) not found, skipping")
      return
    }
    #expect(file.header.version == 1)
    for name in file.staleExclusions(Self.exclusions.keys) {
      Issue.record("stale exclusion: \(name) is no longer a vector")
    }
    let environment = ProcessInfo.processInfo.environment
    let filter = environment["VIM_VECTORS_FILTER"].flatMap { $0.isEmpty ? nil : $0 }
    let report = VimVectorReplayer(header: file.header).runAll(
      file, filter: filter, exclusions: Set(Self.exclusions.keys)
    ) { VimTextBuffer.vectorHost($0) }
    print(report.summary(title: "vim vectors through VimTextBuffer (\(VimVectorFile.defaultURL.lastPathComponent)):"))
    for message in report.issueMessages(verbose: environment["VIM_VECTORS_VERBOSE"] == "1") {
      Issue.record("\(message)")
    }
    #expect(report.passedCount == report.totalCount)
  }
}
