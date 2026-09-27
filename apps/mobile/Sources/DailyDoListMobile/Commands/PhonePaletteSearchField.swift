import SwiftUI
import UIKit

enum PhonePaletteKey: Equatable {
  case move(Int)
  case submit(newTab: Bool, create: Bool)
  case cancel
}

struct PhonePaletteSearchField: UIViewRepresentable {
  @Binding var text: String
  let placeholder: String
  let key: (PhonePaletteKey) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeUIView(context: Context) -> PaletteInput {
    let input = PaletteInput()
    input.borderStyle = .roundedRect
    input.font = .preferredFont(forTextStyle: .body)
    input.adjustsFontForContentSizeCategory = true
    input.autocapitalizationType = .none
    input.autocorrectionType = .no
    input.clearButtonMode = .whileEditing
    input.returnKeyType = .go
    input.accessibilityIdentifier = "palette.query"
    input.delegate = context.coordinator
    input.addTarget(
      context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
    input.onKey = key
    return input
  }
  func updateUIView(_ input: PaletteInput, context: Context) {
    context.coordinator.parent = self
    input.onKey = key
    input.placeholder = placeholder
    input.accessibilityLabel = placeholder
    if input.text != text && input.markedTextRange == nil { input.text = text }
  }
  @MainActor final class Coordinator: NSObject, UITextFieldDelegate {
    var parent: PhonePaletteSearchField
    init(_ parent: PhonePaletteSearchField) { self.parent = parent }
    @objc func changed(_ input: UITextField) { parent.text = input.text ?? "" }
    func textFieldShouldReturn(_ input: UITextField) -> Bool {
      guard input.markedTextRange == nil else { return true }
      parent.key(.submit(newTab: false, create: false))
      return false
    }
  }
}

@MainActor final class PaletteInput: UITextField {
  var onKey: ((PhonePaletteKey) -> Void)?
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      DispatchQueue.main.async { [weak self] in _ = self?.becomeFirstResponder() }
    }
  }
  override var keyCommands: [UIKeyCommand]? {
    // IME candidate navigation belongs to the text input system, never the result list.
    guard markedTextRange == nil else { return super.keyCommands }
    let definitions: [(String, UIKeyModifierFlags)] = [
      (UIKeyCommand.inputUpArrow, []), (UIKeyCommand.inputDownArrow, []),
      ("p", .control), ("n", .control), ("\r", .shift), ("\r", .command),
      ("\r", [.command, .shift]), (UIKeyCommand.inputEscape, []),
    ]
    return definitions.map { input, flags in
      let command = UIKeyCommand(
        input: input, modifierFlags: flags, action: #selector(navigate(_:)))
      command.wantsPriorityOverSystemBehavior = true
      return command
    } + (super.keyCommands ?? [])
  }
  @objc func navigate(_ command: UIKeyCommand) {
    guard markedTextRange == nil else { return }
    switch command.input {
    case UIKeyCommand.inputUpArrow, "p": onKey?(.move(-1))
    case UIKeyCommand.inputDownArrow, "n": onKey?(.move(1))
    case UIKeyCommand.inputEscape: onKey?(.cancel)
    default:
      onKey?(
        .submit(
          newTab: command.modifierFlags.contains(.shift),
          create: command.modifierFlags.contains(.command)))
    }
  }
}
