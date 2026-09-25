import AppKit
import DailyDoListUI
import SwiftUI

/// A switch row of a grouped form: the title on the left, the switch on the right. Only the switch
/// is clickable, so only it shows the pointing hand.
struct SettingsToggle: View {
  let title: String
  @Binding var isOn: Bool

  init(_ title: String, isOn: Binding<Bool>) {
    self.title = title
    self._isOn = isOn
  }

  var body: some View {
    LabeledContent(title) {
      Toggle(title, isOn: $isOn)
        .labelsHidden()
        .toggleStyle(.switch)
        .pointingHandCursor()
    }
  }
}

/// Text field with a local draft that commits on Return or focus loss (not per keystroke). A
/// `required` value is committed trimmed and never blank: a blank draft reverts to the value.
struct CommitTextField: View {
  let title: String
  let value: String
  var prompt: String?
  var monospaced = false
  var required = false
  let onCommit: (String) -> Void
  @State private var draft = ""
  @FocusState private var focused: Bool

  var body: some View {
    field
      .focused($focused)
      .onSubmit(commit)
      .onChange(of: focused) { _, isFocused in if !isFocused { commit() } }
      .onChange(of: value) { _, newValue in if !focused { draft = newValue } }
      .onAppear { draft = value }
  }

  /// In a grouped form the title is the row's label, and a font set on the field would reach it
  /// too: a monospaced value gets its own labeled row.
  @ViewBuilder private var field: some View {
    if monospaced {
      LabeledContent(title) {
        TextField(title, text: $draft, prompt: prompt.map { Text($0) })
          .labelsHidden()
          .multilineTextAlignment(.trailing)
          .font(.system(.body, design: .monospaced))
      }
    } else {
      TextField(title, text: $draft, prompt: prompt.map { Text($0) })
    }
  }

  /// What committing `draft` saves, or nil when nothing changes (the web's `draftToCommit`).
  static func committed(_ draft: String, value: String, required: Bool) -> String? {
    let text = required ? draft.trimmingCharacters(in: .whitespacesAndNewlines) : draft
    return text == value || (required && text.isEmpty) ? nil : text
  }

  private func commit() {
    guard let text = Self.committed(draft, value: value, required: required) else {
      draft = value
      return
    }
    draft = text
    onCommit(text)
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
        Stepper(
          title, value: Binding(get: { value }, set: { onCommit(clamp($0)) }), in: range, step: step
        )
        .labelsHidden()
        .pointingHandCursor()
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
      panel.directoryURL = URL(
        fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true)
    }
    return panel.runModal() == .OK ? panel.url : nil
  }

  /// `~`-abbreviated display of a path.
  static func display(_ path: String) -> String {
    (path as NSString).abbreviatingWithTildeInPath
  }
}
