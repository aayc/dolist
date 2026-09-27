#if canImport(UIKit)
  import UIKit

  extension MobileDrawingCanvasView {
    public override var keyCommands: [UIKeyCommand]? {
      guard mode == .editing, textEditor == nil else { return nil }
      let plain =
        Array("vhrdoalptefxq1234567890").map(String.init)
        + [
          UIKeyCommand.inputEscape, "\r", "\u{8}", UIKeyCommand.inputDelete,
          UIKeyCommand.inputLeftArrow, UIKeyCommand.inputRightArrow,
          UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow,
        ]
      var commands = plain.map {
        UIKeyCommand(input: $0, modifierFlags: [], action: #selector(canvasKey(_:)))
      }
      for key in ["z", "y", "a", "d", "c", "x", "v", "g", "+", "=", "-", "0"] {
        commands.append(
          UIKeyCommand(input: key, modifierFlags: .command, action: #selector(canvasKey(_:))))
      }
      for key in ["z", "g"] {
        commands.append(
          UIKeyCommand(
            input: key, modifierFlags: [.command, .shift], action: #selector(canvasKey(_:))))
      }
      for key in [
        UIKeyCommand.inputLeftArrow, UIKeyCommand.inputRightArrow,
        UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow,
      ] {
        commands.append(
          UIKeyCommand(input: key, modifierFlags: .shift, action: #selector(canvasKey(_:))))
      }
      for command in commands { command.wantsPriorityOverSystemBehavior = true }
      return commands
    }

    @objc private func canvasKey(_ command: UIKeyCommand) {
      guard mode == .editing, textEditor == nil, let input = command.input else { return }
      var modifiers: PointerModifiers = []
      if command.modifierFlags.contains(.command) { modifiers.insert(.command) }
      if command.modifierFlags.contains(.shift) { modifiers.insert(.shift) }
      if modifiers.contains(.command) {
        switch input.lowercased() {
        case "c":
          performTransfer { try controller?.copySelection() }
          return
        case "x":
          performTransfer { try controller?.copySelection(cut: true) }
          return
        case "v":
          performTransfer { try controller?.pasteSelection() }
          return
        case "g":
          if modifiers.contains(.shift) {
            editor.ungroupSelection()
          } else {
            editor.groupSelection()
          }
          return
        case "+", "=":
          zoom(by: 1.25)
          return
        case "-":
          zoom(by: 0.8)
          return
        case "0":
          zoom(by: 1 / viewport.zoom)
          return
        default: break
        }
      }
      let key: DrawingKey
      switch input {
      case UIKeyCommand.inputEscape: key = .escape
      case "\r": key = .enter
      case "\u{8}", UIKeyCommand.inputDelete: key = .delete
      case UIKeyCommand.inputLeftArrow: key = .left
      case UIKeyCommand.inputRightArrow: key = .right
      case UIKeyCommand.inputUpArrow: key = .up
      case UIKeyCommand.inputDownArrow: key = .down
      default:
        guard input.count == 1, let character = input.first else { return }
        key = .character(character)
      }
      editor.handleKey(key, modifiers: modifiers)
    }

    private func performTransfer(_ operation: () throws -> Void) {
      do { try operation() } catch { controller?.commandError = error.localizedDescription }
    }

    public override var accessibilityElements: [Any]? {
      get {
        if let textEditor { return [textEditor] }
        let surface = UIAccessibilityElement(accessibilityContainer: self)
        surface.accessibilityIdentifier = "DrawingCanvasSurface"
        surface.accessibilityLabel = "Drawing canvas"
        surface.accessibilityValue =
          "\(editor.tool.label), \(editor.scene.visibleElements.count) elements"
        surface.accessibilityHint = "Use direct touch to draw. Two fingers pan and pinch to zoom."
        surface.accessibilityTraits = .allowsDirectInteraction
        surface.accessibilityFrameInContainerSpace = bounds
        return [surface]
          + editor.scene.visibleElements.filter { $0.containerId == nil }.map { element in
            DrawingAccessibleElement(canvas: self, element: element)
          }
      }
      set {}
    }
  }

  @MainActor
  private final class DrawingAccessibleElement: UIAccessibilityElement {
    weak var canvas: MobileDrawingCanvasView?
    let elementId: String
    init(canvas: MobileDrawingCanvasView, element: ExcalidrawElement) {
      self.canvas = canvas
      self.elementId = element.id
      super.init(accessibilityContainer: canvas)
      let label =
        element.text?.originalText ?? element.boundTextId.flatMap {
          canvas.editor.element($0)?.text?.originalText
        } ?? element.name ?? element.type.rawValue.capitalized
      accessibilityLabel = String(label.prefix(250))
      accessibilityValue = element.locked ? "Locked" : element.type.rawValue.capitalized
      accessibilityTraits =
        canvas.editor.selectedIds.contains(element.id) ? [.button, .selected] : [.button]
      let box = ElementGeometry.bounds(element)
      let origin = canvas.viewport.sceneToView(DrawingPoint(box.minX, box.minY))
      accessibilityFrameInContainerSpace = CGRect(
        x: origin.x, y: origin.y,
        width: max(44, box.width * canvas.viewport.zoom),
        height: max(44, box.height * canvas.viewport.zoom))
      var actions: [UIAccessibilityCustomAction] = []
      if !element.locked, canvas.mode == .editing {
        actions.append(action("Select") { $0.editor.select([element.id]) })
        if element.type == .text || element.type.isTextContainer {
          actions.append(
            action("Edit text") {
              $0.editor.select([element.id])
              $0.editor.handleKey(.enter)
            })
        }
        actions.append(
          action("Duplicate") {
            $0.editor.select([element.id])
            $0.editor.duplicateSelection()
          })
        actions.append(
          action("Delete") {
            $0.editor.select([element.id])
            $0.editor.deleteSelection()
          })
        for (label, x, y) in [
          ("Move left", -10.0, 0.0), ("Move right", 10.0, 0.0),
          ("Move up", 0.0, -10.0), ("Move down", 0.0, 10.0),
        ] {
          actions.append(
            action(label) {
              $0.editor.select([element.id])
              $0.editor.nudgeSelection(dx: x, dy: y)
            })
        }
      }
      if let link = element.link, canvas.controller?.onOpenLink != nil {
        actions.append(action("Open link") { $0.controller?.onOpenLink?(link) })
      }
      accessibilityCustomActions = actions
    }
    override func accessibilityActivate() -> Bool {
      guard let canvas else { return false }
      if canvas.mode == .editing, canvas.editor.element(elementId)?.locked == false {
        canvas.editor.select([elementId])
      } else if let link = canvas.editor.element(elementId)?.link {
        canvas.controller?.onOpenLink?(link)
      }
      return true
    }
    private func action(_ name: String, perform: @escaping (MobileDrawingCanvasView) -> Void)
      -> UIAccessibilityCustomAction
    {
      UIAccessibilityCustomAction(name: name) { [weak self] _ in
        guard let canvas = self?.canvas else { return false }
        perform(canvas)
        return true
      }
    }
  }
#endif
