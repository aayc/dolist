#if DEBUG
  import DailyDoListEditorCore
  import DailyDoListMobileDrawing
  import DailyDoListMobileEditor
  import SwiftUI

  /// Real touch regression surface with synthetic memory-only content and no host connection.
  struct DrawingSpikeView: View {
    @State private var controller = MobileDrawingController(scene: .init())
    @State private var count = 0
    var body: some View {
      if ProcessInfo.processInfo.arguments.contains("--inline-drawing-spike") {
        InlineDrawingSpikeView()
      } else {
        standalone
      }
    }
    private var standalone: some View {
      VStack {
        Text("Elements: \(count)").accessibilityIdentifier("drawing.count")
        MobileDrawingView(controller: controller)
          .accessibilityIdentifier("drawing.surface")
      }
      .onAppear {
        controller.onChange = { scene in count = scene.elements.filter { !$0.isDeleted }.count }
      }
    }
  }

  /// Uses the production note embed/canvas hierarchy, including the enclosing UITextView's pan.
  /// The scene and source live in memory; UI tests never connect to a daemon or open a vault.
  private struct InlineDrawingSpikeView: View {
    @State private var editor = MobileMarkdownController()
    @State private var drawing = MobileDrawingController(scene: .init())
    @State private var count = 0
    @State private var sourceChanged = false
    @State private var scrollOffset = 0.0
    @State private var configured = false
    private static let source =
      "# Inline drawing\n\n![[Sketch.excalidraw|320x420]]\n\n"
      + Array(repeating: "Synthetic note text keeps the outer note scrollable.", count: 40)
      .joined(separator: "\n\n")

    var body: some View {
      VStack {
        Text("Elements: \(count)").accessibilityIdentifier("drawing.count")
        Text(sourceChanged ? "Note changed" : "Note unchanged")
          .accessibilityIdentifier("drawing.note-source")
        Text("Note scroll: \(Int(scrollOffset.rounded()))")
          .accessibilityIdentifier("drawing.note-scroll")
        MobileMarkdownView(controller: editor)
      }
      .onAppear {
        guard !configured else { return }
        configured = true
        var host = MobileEditorEmbedHost()
        host.loadDrawing = { _ in
          .ready(
            EditorDrawing(
              path: "Sketch.excalidraw.md", scene: drawing.editor.scene,
              contentHash: UInt64(count)))
        }
        host.drawingController = { _ in drawing }
        editor.setEmbedHost(host, identity: "synthetic-inline-drawing")
        editor.load(Self.source)
        editor.onTextChange = { _ in sourceChanged = editor.text != Self.source }
        editor.onScrollChange = { scrollOffset = $0 }
        drawing.onChange = { scene in
          count = scene.visibleElements.count
          editor.drawingsDidChange()
        }
      }
    }
  }
#endif
