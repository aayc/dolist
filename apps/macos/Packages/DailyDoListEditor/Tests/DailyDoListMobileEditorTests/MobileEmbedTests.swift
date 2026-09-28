#if canImport(UIKit)
  @testable import DailyDoListEditorCore
  import DailyDoListMobileDrawing
  import Testing
  import UIKit

  @testable import DailyDoListMobileEditor

  @Suite("Native note embeds", .serialized)
  @MainActor struct MobileEmbedTests {
    private func controller(_ source: String) -> MobileMarkdownController {
      let controller = MobileMarkdownController()
      controller.input.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
      controller.load(source)
      return controller
    }

    @Test func compactFloatReservesSpaceWithoutChangingSourceAndEditsUndo() throws {
      let source = "![[Plan.excalidraw|260|right-wrap]]\nafter"
      let controller = controller(source)
      var host = MobileEditorEmbedHost()
      host.loadDrawing = { _ in .missing }
      host.onOpenLink = { _ in Issue.record("Embed controls must not open their hidden source link")
      }
      controller.setEmbedHost(host, identity: "host/note")
      controller.input.layoutManager.ensureLayout(for: controller.input.textContainer)
      controller.embeds.layout()
      let card = try #require(
        controller.input.subviews.first { $0.accessibilityIdentifier == "note.embed" })
      #expect(card.frame.width > 300)
      #expect(
        controller.linkAtPoint(CGPoint(x: card.frame.maxX - 60, y: card.frame.maxY - 20)) == nil)
      let glyph = controller.input.layoutManager.glyphIndexForCharacter(at: source.utf16.count - 2)
      let next = controller.input.layoutManager.lineFragmentRect(
        forGlyphAt: glyph, effectiveRange: nil)
      #expect(next.minY > 100)
      #expect(controller.text == source)
      let item = try #require(controller.embeds.item(at: 0))
      controller.embeds.resize(item, width: 180)
      #expect(controller.text.contains("|180|right-wrap"))
      controller.input.undoManager?.undo()
      #expect(controller.text == source)
    }

    @Test func changedIdentityRejectsSuspendedLoadAndUpload() async throws {
      let controller = controller("![[Plan.excalidraw]]\nafter")
      var continuation: CheckedContinuation<EditorDrawingState, Never>?
      var upload: CheckedContinuation<String, Never>?
      var host = MobileEditorEmbedHost()
      host.loadDrawing = { _ in await withCheckedContinuation { continuation = $0 } }
      host.importAttachment = { _, _, _ in await withCheckedContinuation { upload = $0 } }
      controller.setEmbedHost(host, identity: "old/note")
      controller.embeds.layout()
      for _ in 0..<100 where continuation == nil { await Task.yield() }
      _ = try #require(continuation)
      let importing = Task {
        try await controller.importAttachment(
          data: Data([1]), filename: "a.png", mimeType: "image/png")
      }
      for _ in 0..<100 where upload == nil { await Task.yield() }
      _ = try #require(upload)
      var next = MobileEditorEmbedHost()
      next.loadDrawing = { _ in .missing }
      controller.setEmbedHost(next, identity: "new/note")
      continuation?.resume(
        returning: .ready(
          EditorDrawing(path: "old.excalidraw.md", scene: ExcalidrawScene(), contentHash: 9)))
      upload?.resume(returning: "old.png")
      #expect(try await importing.value == false)
      for _ in 0..<10 { await Task.yield() }
      let item = try #require(controller.embeds.item(at: 0))
      #expect(controller.embeds.drawingState(item)?.drawing == nil)
      #expect(!controller.text.contains("old.png"))
    }

    @Test func dependencyTargetsAndSafeLinksRemainSourceBased() throws {
      let controller = controller(
        "![[Plan.excalidraw]]\n![[photo.png|200]]\n[[Note#Section]]\n[unsafe](javascript:alert)\nhttps://example.test"
      )
      var drawings: Set<String> = []
      var files: Set<String> = []
      var opened: [EditorLinkPreview.Target] = []
      var host = MobileEditorEmbedHost()
      host.onDependenciesChanged = {
        drawings = $0
        files = $1
      }
      host.onOpenLink = { opened.append($0) }
      controller.setEmbedHost(host, identity: "a")
      controller.embeds.layout()
      #expect(drawings == ["Plan.excalidraw"] && files == ["photo.png"])
      #expect(
        controller.openLink(atUTF16: (controller.text as NSString).range(of: "Note").location))
      #expect(
        !controller.openLink(atUTF16: (controller.text as NSString).range(of: "unsafe").location))
      #expect(
        controller.openLink(atUTF16: (controller.text as NSString).range(of: "https").location))
      #expect(opened.count == 2)
    }

    @Test func configurationUsesReadableColumnsAndVisibleLineNumbers() {
      let controller = controller("one\ntwo\nthree")
      controller.input.frame.size.width = 1100
      controller.updateConfiguration(
        EditorConfiguration(readableLineLength: true, showLineNumbers: true))
      controller.input.layoutIfNeeded()
      #expect(controller.input.textContainerInset.left > 100)
      #expect(controller.lineNumberGutter.superview === controller.input)
      let column =
        controller.input.bounds.width - controller.input.textContainerInset.left
        - controller.input.textContainerInset.right
      #expect(column == 700)
      controller.updateConfiguration(
        EditorConfiguration(readableLineLength: false, showLineNumbers: false))
      #expect(controller.lineNumberGutter.superview == nil)
      #expect(controller.input.textContainerInset.left == 16)
    }

    @Test func insertingIntoTableKeepsTheWholeTableAndOneUndoRestoresSource() throws {
      let table = "| Plant | Light |\n| --- | --- |\n| **Fern** | Shade |\n| Moss | Shade |"
      let source = table + "\n\nAfter the table."
      let controller = controller(source)
      controller.selection = NSRange(
        location: (source as NSString).range(of: "Fern").location, length: 0)
      #expect(controller.insertAttachment(target: "attachments/garden.png"))
      #expect(controller.text.hasPrefix(table + "\n\n![[attachments/garden.png]]\n\n"))
      #expect(controller.text.hasSuffix("After the table."))
      #expect(controller.content.index.tables.first?.last == 3)
      controller.input.undoManager?.undo()
      #expect(controller.text == source)
    }

    @Test func attachmentHiddenInsideTableHasNoOverlappingPreview() {
      let controller = controller(
        "| Plant | Light |\n| --- | --- |\n![[garden.png]]\n| Fern | Shade |\n\nAfter")
      var host = MobileEditorEmbedHost()
      host.loadAttachment = { _ in .unavailable }
      controller.setEmbedHost(host, identity: "table-overlap")
      controller.selection = NSRange(location: controller.text.utf16.count, length: 0)
      controller.updatePreview()
      let offset = (controller.text as NSString).range(of: "![[garden.png]]").location
      #expect(controller.content.hiddenRange(at: offset) != nil)
      #expect(!controller.embeds.draws(at: offset))
    }

    @Test func replacementChangesOnlyExactAttachmentTargetsAndUndoPreservesSource() {
      let source =
        "![[old.png|200|right-wrap]]\n![[other.png]]\n![old.png](<old.png> \"old.png\")\n[ordinary](old.png)\n\n```\n![[old.png]]\n```"
      let controller = controller(source)
      #expect(controller.replaceAttachment(target: "old.png", with: "new.png"))
      #expect(
        controller.text
          == "![[new.png|200|right-wrap]]\n![[other.png]]\n![old.png](<new.png> \"old.png\")\n[ordinary](old.png)\n\n```\n![[old.png]]\n```"
      )
      controller.input.undoManager?.undo()
      #expect(controller.text == source)
    }

    @Test func attachmentDecoderKeepsHostsSeparateAndPDFsStaticAndBounded() async throws {
      func png(_ color: UIColor) -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 20, height: 10)).pngData { context in
          color.setFill()
          context.fill(CGRect(x: 0, y: 0, width: 20, height: 10))
        }
      }
      let red = MobileEditorAttachment(
        path: "image.png", data: png(.red), mimeType: "image/png", version: "v1")
      let blue = MobileEditorAttachment(
        path: "image.png", data: png(.blue), mimeType: "image/png", version: "v1")
      let decoder = MobileAttachmentDecoder()
      let first = try #require(await decoder.preview(red, identity: "host-a"))
      let second = try #require(await decoder.preview(blue, identity: "host-b"))
      #expect(first.image.dataProvider?.data != second.image.dataProvider?.data)
      let data = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 300)).pdfData
      { context in
        context.beginPage()
        context.beginPage()
      }
      let pdf = MobileEditorAttachment(
        path: "report.pdf", data: data, mimeType: "application/pdf", version: "v1")
      let document = try #require(await decoder.preview(pdf, identity: "host", page: 2))
      #expect(document.pageCount == 2)
      #expect(document.image.width <= 1600 && document.image.height <= 1600)
      let activeSVG = MobileEditorAttachment(
        path: "image.svg", data: Data("<svg><script>alert(1)</script></svg>".utf8),
        mimeType: "image/svg+xml", version: "bad")
      #expect(await decoder.preview(activeSVG, identity: "host") == nil)
      let oversized = MobileEditorAttachment(
        path: "image.png",
        data: Data(repeating: 0, count: MobileAttachmentDecoder.maximumBytes + 1),
        mimeType: "image/png", version: "large")
      #expect(await decoder.preview(oversized, identity: "host") == nil)
    }
  }
#endif
