import AppKit
import SwiftUI

/// Text field with a local draft that commits on Return or focus loss (not per keystroke).
struct CommitTextField: View {
  let title: String
  let value: String
  var prompt: String?
  var monospaced = false
  let onCommit: (String) -> Void
  @State private var draft = ""
  @FocusState private var focused: Bool

  var body: some View {
    TextField(title, text: $draft, prompt: prompt.map { Text($0) })
      .font(monospaced ? .system(.body, design: .monospaced) : .body)
      .focused($focused)
      .onSubmit(commit)
      .onChange(of: focused) { _, isFocused in if !isFocused { commit() } }
      .onChange(of: value) { _, newValue in if !focused { draft = newValue } }
      .onAppear { draft = value }
  }

  private func commit() {
    if draft != value { onCommit(draft) }
  }
}

/// Integer field + stepper clamped to a range; commits on Return, focus loss or stepping.
struct ClampedNumberField: View {
  let title: String
  let value: Int
  let range: ClosedRange<Int>
  var step = 1
  var unit: String?
  let onCommit: (Int) -> Void
  @State private var draft = ""
  @FocusState private var focused: Bool

  var body: some View {
    LabeledContent(title) {
      HStack(spacing: 6) {
        TextField(title, text: $draft)
          .labelsHidden()
          .multilineTextAlignment(.trailing)
          .frame(width: 90)
          .focused($focused)
          .onSubmit(commit)
          .onChange(of: focused) { _, isFocused in if !isFocused { commit() } }
        Stepper(title, value: Binding(get: { value }, set: { onCommit(clamp($0)) }), in: range, step: step)
          .labelsHidden()
        if let unit { Text(unit).foregroundStyle(.secondary) }
      }
    }
    .onChange(of: value) { _, newValue in if !focused { draft = String(newValue) } }
    .onAppear { draft = String(value) }
  }

  private func clamp(_ number: Int) -> Int { min(range.upperBound, max(range.lowerBound, number)) }

  private func commit() {
    guard let number = Int(draft.trimmingCharacters(in: .whitespaces)) else {
      draft = String(value)
      return
    }
    let clamped = clamp(number)
    draft = String(clamped)
    if clamped != value { onCommit(clamped) }
  }
}

/// Inline explanatory or warning text under a control.
struct SettingsNote: View {
  let text: String
  var tone: Color = .secondary

  var body: some View {
    Text(text)
      .font(.caption)
      .foregroundStyle(tone)
      .fixedSize(horizontal: false, vertical: true)
  }
}

enum FolderPicker {
  /// Asks for a folder; nil when cancelled.
  @MainActor
  static func choose(title: String, startingAt path: String?) -> URL? {
    let panel = NSOpenPanel()
    panel.title = title
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    if let path, !path.isEmpty {
      panel.directoryURL = URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true)
    }
    return panel.runModal() == .OK ? panel.url : nil
  }

  /// `~`-abbreviated display of a path.
  static func display(_ path: String) -> String {
    (path as NSString).abbreviatingWithTildeInPath
  }
}
