import DailyDoListDrawing
import DailyDoListEditor
import DailyDoListUI
import SwiftUI

/// A drawing opened on its own (`Excalidraw/Plan.excalidraw.md`): the whole pane is the drawing,
/// edited in the native canvas with its tool bar, saved like drawings edited in place. A button
/// shows the file's Markdown source instead (and back).
struct DrawingDocumentPane: View {
  let workspace: Workspace
  let path: String
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let state = workspace.drawingState(forDocument: path, revision: workspace.drawingsRevision)
    ZStack(alignment: .topTrailing) {
      switch state {
      case .ready(let drawing):
        DrawingCanvasRepresentable(
          drawing: drawing, theme: colorScheme == .dark ? .dark : .light
        ) { scene in
          workspace.drawings.edit(path, scene: scene)
        }
        .accessibilityLabel("Drawing")
      case .loading:
        ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
      case .missing, .unreadable:
        VStack(spacing: 8) {
          Text(state == .missing ? "Drawing not found" : "Couldn't show this drawing")
            .font(.title3.weight(.semibold))
            .foregroundStyle(Theme.mutedText)
          Text("Its Markdown source is still there.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.faintText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      DrawingSourceToggle(workspace: workspace, path: path, showsSource: false)
        .padding(10)
    }
    .background(Theme.background)
  }
}

/// Switches a drawing between the drawing and its Markdown source.
struct DrawingSourceToggle: View {
  let workspace: Workspace
  let path: String
  let showsSource: Bool

  var body: some View {
    IconButton(
      showsSource ? "scribble.variable" : "doc.plaintext",
      label: showsSource ? "Show drawing" : "Show Markdown source"
    ) {
      Task { await workspace.setShowsDrawingSource(!showsSource, for: path) }
    }
    .accessibilityIdentifier("drawing-source-toggle")
  }
}

/// The canvas in editing mode, filling the pane. New versions from the store (saved elsewhere,
/// merged) replace its scene when they differ from what it reported last.
private struct DrawingCanvasRepresentable: NSViewRepresentable {
  let drawing: EditorDrawing
  let theme: DrawingTheme
  let onChange: @MainActor (ExcalidrawScene) -> Void

  final class Coordinator {
    var reportedHash: UInt64 = 0
    var path = ""
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeNSView(context: Context) -> DrawingCanvasView {
    let canvas = DrawingCanvasView(scene: drawing.scene, mode: .editing, theme: theme)
    context.coordinator.reportedHash = drawing.contentHash
    context.coordinator.path = drawing.path
    let coordinator = context.coordinator
    canvas.onChange = { scene in
      coordinator.reportedHash = DrawingContentHash.hash(scene)
      onChange(scene)
    }
    DispatchQueue.main.async { canvas.window?.makeFirstResponder(canvas) }
    return canvas
  }

  func updateNSView(_ canvas: DrawingCanvasView, context: Context) {
    if canvas.theme != theme { canvas.theme = theme }
    let coordinator = context.coordinator
    guard drawing.contentHash != coordinator.reportedHash else { return }
    coordinator.reportedHash = drawing.contentHash
    canvas.setScene(drawing.scene, keepHistory: coordinator.path == drawing.path)
    coordinator.path = drawing.path
  }
}
