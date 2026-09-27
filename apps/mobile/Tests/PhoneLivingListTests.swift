import DailyDoListAgentCore
import DailyDoListEditorCore
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoList

@MainActor struct PhoneLivingListTests {
  @Test func workingHeaderDoesNotClaimStaleOrUnrelatedActivityBelongsToTheCurrentNote() throws {
    let reading = OrchestratorActivity(
      phase: .reading, turnId: "turn",
      trigger: .init(kind: .note, notePath: "Daily/Today.md", summary: "a note"))
    #expect(
      PhoneOrchestratorPresentation(activity: reading, currentPath: "Daily/Today.md", online: false)
        == nil)
    #expect(
      PhoneOrchestratorPresentation(activity: .idle, currentPath: "Daily/Today.md", online: true)
        == nil)
    #expect(
      PhoneOrchestratorPresentation(activity: reading, currentPath: "Daily/Today.md", online: true)?
        .text == "Orchestrator: reading this note…")
    #expect(
      PhoneOrchestratorPresentation(activity: reading, currentPath: "Elsewhere.md", online: true)?
        .text == "Orchestrator: working on Today")
  }

  @Test func previewUsesOnlyAuthoringThreadSourcesAndRefusesLateConnectionResults() async throws {
    let url = try #require(URL(string: "https://example.test/reference"))
    let request = PhoneNoteLinkRequest(
      link: EditorLinkPreview(
        target: .external(url), label: "1", agentThreadId: "source-thread"))
    var current = true
    var requested: [String] = []
    let model = PhoneNoteLinkPreviewModel(
      request: request, isCurrent: { current },
      cachedNote: { _, _ in
        Issue.record("External source preview must not read a note")
        return nil
      },
      savedSources: { id in
        requested.append(id)
        current = false
        return [
          CitedSource(url: url.absoluteString, title: "Late source", snippet: "Saved excerpt")
        ]
      })
    await model.load()
    #expect(requested == ["source-thread"])
    if case .external(let preview) = model.content {
      #expect(preview.title != "Late source")
    } else {
      Issue.record("Expected safe URL fallback")
    }
    current = true
    let saved = PhoneNoteLinkPreviewModel(
      request: request, isCurrent: { true }, cachedNote: { _, _ in nil },
      savedSources: { _ in
        [CitedSource(url: url.absoluteString, title: "Stored title", snippet: "Stored excerpt")]
      })
    await saved.load()
    if case .external(let preview) = saved.content {
      #expect(preview.title == "Stored title" && preview.snippet == "Stored excerpt")
    } else {
      Issue.record("Expected source-backed preview")
    }
  }

  @Test func cachedNotePreviewIsBoundedAndExplicitInvalidationClearsIt() async {
    let model = PhoneNoteLinkPreviewModel(
      request: PhoneNoteLinkRequest(
        link: EditorLinkPreview(target: .note(target: "Note", subpath: nil), label: "Note")),
      isCurrent: { true },
      cachedNote: { _, _ in
        PhoneCachedNotePreview(path: "Note.md", text: String(repeating: "word ", count: 2000))
      },
      savedSources: { _ in
        Issue.record("Note preview must not load a conversation")
        return []
      })
    await model.load()
    if case .note(_, let lines) = model.content {
      #expect(lines.count == 1 && lines[0].count <= 240)
    } else {
      Issue.record("Expected cached note")
    }
    model.invalidate()
    #expect(model.content == .unavailable)
  }
}
