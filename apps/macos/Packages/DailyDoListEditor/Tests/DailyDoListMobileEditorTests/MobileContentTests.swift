#if canImport(UIKit)
  import Testing
  import UIKit

  @testable import DailyDoListEditorCore
  @testable import DailyDoListMobileEditor

  @Suite("Native tables, callouts and backlinks", .serialized)
  @MainActor struct MobileContentTests {
    private func content(_ source: String) throws -> (
      MobileMarkdownController, MobileContentCoordinator
    ) {
      let owner = MobileMarkdownController()
      owner.input.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
      owner.load(source)
      let content = MobileContentCoordinator(owner: owner)
      let glyphs = try #require(owner.input.layoutManager.delegate as? MobileGlyphDelegate)
      glyphs.contentRange = { [weak content] in content?.hiddenRange(at: $0) }
      glyphs.contentFragment = { [weak content] in content?.fragment(at: $0, proposed: $1) }
      content.rebuild()
      owner.input.layoutManager.ensureLayout(for: owner.input.textContainer)
      content.layout()
      return (owner, content)
    }

    @Test func tablePresentationPreservesRowsAndSourceSelection() throws {
      let source = "| **Name** | Status |\n| :--- | ---: |\n| Example | Ready |\n\nafter"
      let (owner, content) = try content(source)
      let rows = owner.input.subviews.compactMap { $0 as? MobileTableRowView }
      #expect(rows.count == 2)
      #expect(rows[0].frame.height >= 40)
      #expect(owner.text == source)
      let cell = try #require(content.index.lines[2].cells?.first)
      content.reveal(line: 2, cell: cell)
      #expect((owner.text as NSString).substring(with: owner.selection) == "Example")
      owner.input.insertText("Changed")
      #expect(owner.text.contains("| Changed | Ready |"))
      owner.input.undoManager?.undo()
      #expect(owner.text == source)
      #expect(
        MobileMarkdownStyle(fontSize: 16).contentText("# literal **bold**").string
          == "# literal bold")
    }

    @Test func calloutFoldingChangesLayoutWithoutEditingSource() throws {
      let source = "> [!warning]- Careful\n> First body\n> Second body\n\nafter"
      let (owner, content) = try content(source)
      func afterY() -> CGFloat {
        owner.input.layoutManager.ensureLayout(for: owner.input.textContainer)
        let index = (owner.text as NSString).range(of: "after").location
        let glyph = owner.input.layoutManager.glyphIndexForCharacter(at: index)
        return owner.input.layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
          .minY
      }
      let folded = afterY()
      content.toggleCallout(0)
      content.layout()
      let unfolded = afterY()
      #expect(unfolded > folded + 20)
      #expect(owner.text == source)
      #expect(owner.input.subviews.contains { $0.accessibilityIdentifier == "note.callout.header" })
      owner.updateConfiguration(EditorConfiguration(livePreview: false))
      content.layout()
      #expect(
        owner.input.subviews.allSatisfy { $0.accessibilityIdentifier != "note.callout.header" })
      #expect(owner.text == source)
    }

    @Test func backlinksIgnorePreviousHostResultsAndKeepCoverageHonest() async throws {
      let model = MobileBacklinksModel()
      var oldResult: CheckedContinuation<EditorBacklinksSnapshot, Never>?
      let previous = Task {
        await model.load(identity: "old", notePath: "Note.md") { _ in
          await withCheckedContinuation { oldResult = $0 }
        }
      }
      for _ in 0..<100 where oldResult == nil { await Task.yield() }
      let suspended = try #require(oldResult)
      let mention = EditorBacklinkMention(
        path: "New.md", line: 4, context: "A linked mention", kind: .linked)
      await model.load(identity: "new", notePath: "Note.md") { _ in
        EditorBacklinksSnapshot(mentions: [mention, mention], coverage: .partial)
      }
      suspended.resume(
        returning: EditorBacklinksSnapshot(mentions: [
          EditorBacklinkMention(path: "Old.md", line: 0, context: "Old host", kind: .unlinked)
        ]))
      await previous.value
      #expect(model.snapshot?.mentions == [mention])
      #expect(model.snapshot?.coverage == .partial)
      await model.load(identity: "new", notePath: "Note.md") { _ in
        throw CocoaError(.fileReadNoSuchFile)
      }
      #expect(model.snapshot?.mentions == [mention])
      #expect(model.snapshot?.coverage == .cached(updatedAt: nil))
      #expect(model.error != nil && !model.loading)
    }
  }
#endif
