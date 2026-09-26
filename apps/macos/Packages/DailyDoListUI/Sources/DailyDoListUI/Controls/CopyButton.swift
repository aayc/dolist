import AppKit
import SwiftUI

/// The general pasteboard, for Copy buttons and menu items.
@MainActor
public enum Clipboard {
  public static func copy(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }
}

/// Copies `text` (a message, a code block, a pairing code); a check confirms it for a moment.
public struct CopyButton: View {
  let text: String
  let label: String
  let size: IconButton.Size
  @State private var copies = 0
  @State private var copied = false

  public init(text: String, label: String, size: IconButton.Size = .compact) {
    self.text = text
    self.label = label
    self.size = size
  }

  public var body: some View {
    IconButton(copied ? "checkmark" : "doc.on.doc", label: copied ? "Copied" : label, size: size) {
      Clipboard.copy(text)
      copied = true
      copies += 1
    }
    .contentTransition(.symbolEffect(.replace))
    .task(id: copies) {
      guard copies > 0 else { return }
      try? await Task.sleep(for: .seconds(1.2))
      guard !Task.isCancelled else { return }
      copied = false
    }
  }
}
