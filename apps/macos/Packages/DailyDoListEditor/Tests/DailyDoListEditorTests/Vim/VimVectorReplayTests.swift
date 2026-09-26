import AppKit
import DailyDoListVim
import DailyDoListVimTestSupport
import Foundation
import Testing

@testable import DailyDoListEditor

/// Replays every case of the web app's vim vectors (`packages/editor/test/vim/vectors.jsonl`)
/// through the real Mac editor: `MarkdownEditorController` offscreen, its `VimEditor`
/// (`TextViewVimHost`), the editor's edit pipeline, undo manager and layout manager. Twice: with
/// live preview off, and on (hidden syntax, lines relaid out as the cursor reveals them), like
/// the web app replays them against its editor.
///
/// `VIM_VECTORS_FILTER` replays the cases whose name contains it; `VIM_VECTORS_VERBOSE=1` records
/// every mismatch instead of the first few per category.
@MainActor
@Suite("Vim vectors through the editor", .serialized)
struct VimVectorReplayTests {
  /// Cases that are not replayed, with the reason. Keep this list short and justified.
  static let exclusions: [String: String] = [:]

  @Test(arguments: [false, true])
  func everyVectorPassesThroughTheRealEditor(livePreview: Bool) throws {
    guard let file = try VimVectorFile.loadDefault() else {
      print("vim vectors: \(VimVectorFile.defaultURL.path) not found, skipping")
      return
    }
    for name in file.staleExclusions(Self.exclusions.keys) {
      Issue.record("stale exclusion: \(name) is no longer a vector")
    }
    let environment = ProcessInfo.processInfo.environment
    let filter = environment["VIM_VECTORS_FILTER"].flatMap { $0.isEmpty ? nil : $0 }
    let hosts = EditorVectorHosts(header: file.header, livePreview: livePreview)
    let report = VimVectorReplayer(header: file.header).runAll(
      file, filter: filter, exclusions: Set(Self.exclusions.keys)
    ) {
      hosts.host(for: $0)
    }
    let title =
      "vim vectors through MarkdownEditorController, live preview \(livePreview ? "on" : "off") (\(VimVectorFile.defaultURL.lastPathComponent)):"
    print(report.summary(title: title))
    for message in report.issueMessages(verbose: environment["VIM_VECTORS_VERBOSE"] == "1") {
      Issue.record("\(message)")
    }
    #expect(report.passedCount == report.totalCount)
  }
}
