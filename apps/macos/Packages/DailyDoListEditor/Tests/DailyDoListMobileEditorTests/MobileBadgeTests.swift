#if canImport(UIKit)
  import DailyDoListEditorCore
  import Testing
  import UIKit
  @testable import DailyDoListMobileEditor

  @MainActor @Suite(.serialized)
  struct MobileBadgeTests {
    @Test func badgeHasItsOwnTouchableSpaceAndNeverEntersCopiedMarkdown() async throws {
      let editor = MobileMarkdownController()
      editor.input.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
      editor.load("- [ ] Synthetic task\nFollowing paragraph")
      var tapped: String?
      editor.onBadgeTap = { tapped = $0.threadId }
      editor.setBadges([
        EditorBadge(
          id: "task", line: 0, status: "waiting_approval", label: "Needs approval",
          threadId: "thread")
      ])
      editor.annotations.layout()
      editor.input.layoutManager.ensureLayout(for: editor.input.textContainer)
      let button = try #require(editor.input.subviews.compactMap { $0 as? UIButton }.first)
      let next = editor.input.layoutManager.glyphIndexForCharacter(at: 21)
      let rect = editor.input.layoutManager.lineFragmentUsedRect(
        forGlyphAt: next, effectiveRange: nil
      )
      .offsetBy(dx: editor.input.textContainerInset.left, dy: editor.input.textContainerInset.top)
      #expect(!button.frame.intersects(rect))
      button.sendActions(for: .touchUpInside)
      #expect(tapped == "thread")
      #expect(editor.text == "- [ ] Synthetic task\nFollowing paragraph")
      editor.selection = NSRange(location: 0, length: 0)
      editor.input.insertText("Above\n")
      for _ in 0..<5 { await Task.yield() }
      #expect(editor.badges.first?.line == 1)
      editor.setBadges([])
      editor.annotations.layout()
      #expect(editor.input.subviews.compactMap { $0 as? UIButton }.isEmpty)
      let spacing =
        editor.input.textStorage.attribute(.paragraphStyle, at: 6, effectiveRange: nil)
        as? NSParagraphStyle
      #expect(spacing?.paragraphSpacing == 3)
    }
  }
#endif
