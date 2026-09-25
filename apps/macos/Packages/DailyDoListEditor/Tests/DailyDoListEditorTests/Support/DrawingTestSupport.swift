import AppKit
import DailyDoListDrawing
import DailyDoListVim

@testable import DailyDoListEditor

/// Synthetic drawings for tests.
enum TestDrawings {
  /// A scene with a filled rectangle, an ellipse and an arrow between them, about `width` ×
  /// `height` at 100% (export padding included).
  static func scene(width: Double = 400, height: Double = 200, seed: Int = 1) -> ExcalidrawScene {
    var box = ExcalidrawElement(id: "box-\(seed)", type: .rectangle)
    box.x = 0
    box.y = 0
    box.width = width * 0.35
    box.height = height - 20
    box.seed = seed
    box.backgroundColor = "#a5d8ff"
    box.fillStyle = .solid
    var oval = ExcalidrawElement(id: "oval-\(seed)", type: .ellipse)
    oval.x = width * 0.6
    oval.y = 0
    oval.width = width * 0.4 - 20
    oval.height = height - 20
    oval.seed = seed + 1
    oval.strokeColor = "#e03131"
    return ExcalidrawScene(elements: [box, oval])
  }

  static func drawing(
    _ path: String = "Excalidraw/Plan.excalidraw.md", scene: ExcalidrawScene = scene()
  ) -> EditorDrawing {
    EditorDrawing(path: path, scene: scene, contentHash: DrawingContentHash.hash(scene))
  }

  /// A long paragraph that wraps several times in a narrow column.
  static let paragraph =
    "Text flows around drawings the way it does in Obsidian: every word of this sentence keeps "
    + "clear of the float next to it, line after line, until the float ends and the text takes "
    + "the whole column again for the rest of the paragraph."
}

/// Serves drawings and records what the editor tells its host about them.
@MainActor
final class DrawingDelegate: MarkdownEditorDelegate {
  /// What `drawingFor` answers per target (nil: the embed stays text).
  var drawings: [String: EditorDrawingState] = [:]
  var asked: [String] = []
  var edits: [EditorDrawing] = []
  var endedEditing: [String] = []
  var textChanges = 0
  var menus: [NSMenu] = []

  func editor(_ editor: MarkdownEditorController, drawingFor target: String) -> EditorDrawingState?
  {
    asked.append(target)
    return drawings[target]
  }
  func editor(_ editor: MarkdownEditorController, didEditDrawing drawing: EditorDrawing) {
    edits.append(drawing)
    drawings = drawings.mapValues { $0.drawing?.path == drawing.path ? .ready(drawing) : $0 }
  }
  func editor(_ editor: MarkdownEditorController, didEndEditingDrawing path: String) {
    endedEditing.append(path)
  }
  func editorTextDidChange(_ editor: MarkdownEditorController, text: String) { textChanges += 1 }
  func editor(_ editor: MarkdownEditorController, willShowContextMenu menu: NSMenu) {
    menus.append(menu)
  }
}

/// An editor showing drawings in an offscreen window, driven with real mouse and key events.
@MainActor
final class DrawingEditorHarness {
  let controller: MarkdownEditorController
  let window: VimTestWindow
  let delegate = DrawingDelegate()
  private var time: TimeInterval = 1000

  /// `caret` defaults to the end of the text (embeds use `|`, so there's no marked notation).
  init(
    text: String, caret: Int? = nil, drawings: [String: EditorDrawingState] = [:],
    configuration: EditorConfiguration = EditorConfiguration(),
    size: NSSize = NSSize(width: 760, height: 900), appearance: NSAppearance.Name = .aqua
  ) {
    let selection = NSRange(location: caret ?? (text as NSString).length, length: 0)
    controller = MarkdownEditorController(configuration: configuration)
    window = VimTestWindow(
      contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    window.appearance = NSAppearance(named: appearance)
    window.contentView = controller.view
    controller.view.frame = NSRect(origin: .zero, size: size)
    controller.view.layoutSubtreeIfNeeded()
    delegate.drawings = drawings
    controller.delegate = delegate
    controller.setText(text, resetUndo: true)
    controller.noteUndoManager.groupsByEvent = false
    window.makeFirstResponder(controller.textView)
    controller.setSelection([selection], adjust: false)
    delegate.textChanges = 0
    layout()
  }

  deinit {
    MainActor.assumeIsolated { window.close() }
  }

  var textView: MarkdownTextView { controller.markdownTextView }
  var text: String { controller.text }
  var selection: NSRange { textView.selectedRange() }
  var undoManager: UndoManager { controller.noteUndoManager }

  /// Lays out the whole document and its floats (there's no draw pass offscreen).
  func layout() {
    controller.layoutManager.ensureLayout(for: controller.textContainer)
    controller.layoutEmbeds()
    controller.layoutManager.ensureLayout(for: controller.textContainer)
  }

  func offset(of needle: String) -> Int { (text as NSString).range(of: needle).location }

  /// The drawn embed on a line and its box (text-view coordinates).
  func box(line: Int) -> CGRect? {
    guard let embed = controller.embedLine(line) else { return nil }
    return controller.embedBoxInView(embed)
  }

  /// Rects (text-view coordinates) of every glyph fragment of `range`, one per line fragment.
  func lineRects(of range: NSRange) -> [CGRect] {
    let layoutManager = controller.layoutManager
    let glyphs = layoutManager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
    let origin = textView.textContainerOrigin
    var rects: [CGRect] = []
    layoutManager.enumerateLineFragments(forGlyphRange: glyphs) { _, used, _, fragment, _ in
      let piece = NSIntersectionRange(fragment, glyphs)
      guard piece.length > 0 else { return }
      let bounds = layoutManager.boundingRect(
        forGlyphRange: piece, in: self.controller.textContainer)
      // Hidden syntax has no advance (TextKit still reports a 1 pt box for it).
      guard bounds.width > 1 else { return }
      rects.append(bounds.offsetBy(dx: origin.x, dy: origin.y))
      _ = used
    }
    return rects
  }

  // MARK: Events

  func mouse(_ type: NSEvent.EventType, at point: CGPoint, clickCount: Int = 1) -> NSEvent {
    time += 0.05
    return NSEvent.mouseEvent(
      with: type, location: textView.convert(point, to: nil), modifierFlags: [], timestamp: time,
      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clickCount,
      pressure: 1)!
  }

  /// A click as the text view gets it. One the editor doesn't take (on text) stops there:
  /// NSTextView's own `mouseDown` would wait in a tracking loop for a real mouse up.
  func click(_ point: CGPoint, count: Int = 1) {
    let down = mouse(.leftMouseDown, at: point, clickCount: count)
    let handled = controller.textView(
      textView, mouseDownAt: textView.convert(down.locationInWindow, from: nil),
      modifiers: down.modifierFlags, clickCount: count)
    guard handled else { return }
    textView.mouseUp(with: mouse(.leftMouseUp, at: point, clickCount: count))
  }

  /// A press, drag and release, each step its own event. `beforeRelease` sees the state while
  /// the button is still down.
  func drag(
    from start: CGPoint, to end: CGPoint, steps: Int = 8, beforeRelease: () -> Void = {}
  ) {
    guard controller.textView(textView, mouseDownAt: start, modifiers: [], clickCount: 1) else {
      return
    }
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
      textView.mouseDragged(with: mouse(.leftMouseDragged, at: point))
    }
    beforeRelease()
    textView.mouseUp(with: mouse(.leftMouseUp, at: end))
    layout()
  }

  func mouseMoved(to point: CGPoint) {
    textView.mouseMoved(with: mouse(.mouseMoved, at: point))
  }

  /// A key (vim notation: "x", "<CR>", "<Esc>", "<BS>", "<Down>") sent to the first responder, as
  /// the window would.
  func press(_ key: String) {
    let event = VimEditorHarness.event(for: key, window: window)
    if let responder = window.firstResponder as? NSView {
      if event.modifierFlags.contains(.command), responder.performKeyEquivalent(with: event) {
        layout()
        return
      }
      responder.keyDown(with: event)
    }
    layout()
  }

  /// Types through the text view's `insertText`/`insertNewline` in one undo group (keys that edit
  /// text through `keyDown` would open NSTextView's own typing group).
  func type(_ string: String) {
    let manager = undoManager
    manager.beginUndoGrouping()
    for character in string {
      if character == "\n" {
        textView.insertNewline(nil)
      } else {
        textView.insertText(
          String(character), replacementRange: NSRange(location: NSNotFound, length: 0))
      }
    }
    manager.endUndoGrouping()
    layout()
  }

  func undo() {
    if undoManager.canUndo { undoManager.undo() }
    layout()
  }

  /// The text view (with its subviews) as the screen would show it.
  func snapshot() -> NSBitmapImageRep {
    layout()
    let view = textView
    view.appearance = window.appearance
    let rep = view.bitmapImageRepForCachingDisplay(in: view.visibleRect)!
    view.cacheDisplay(in: view.visibleRect, to: rep)
    return rep
  }
}
