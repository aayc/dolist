import DailyDoListEditor
import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// The vimrc (Settings → Appearance → Editor, while vim key bindings are on): a monospaced editor
/// committed when typing pauses and when it loses focus, and the lines vim rejected (like the web
/// app's settings).
struct VimrcEditor: View {
  let model: AppModel
  let settings: SettingsStore
  @State private var draft = ""
  @State private var committed = ""
  @FocusState private var focused: Bool

  static let placeholder = [
    "\" One ex command per line, for example:", "imap jj <Esc>", "nmap j gj",
    "set clipboard=unnamed",
  ]
  .joined(separator: "\n")
  static let commitDelay: Duration = .milliseconds(800)

  var body: some View {
    let saved = settings.settings.editor.vimrc
    VStack(alignment: .leading, spacing: 6) {
      Text("vimrc").font(.body.weight(.medium))
      Text(
        "Ex commands to run when vim starts, one per line; lines starting with \" are comments. Supports map/noremap and friends, set, let mapleader and exmap with obcommand."
      )
      .font(.caption)
      .foregroundStyle(Theme.mutedText)
      .fixedSize(horizontal: false, vertical: true)
      ZStack(alignment: .topLeading) {
        TextEditor(text: $draft)
          .font(.system(size: 12, design: .monospaced))
          .autocorrectionDisabled()
          .scrollContentBackground(.hidden)
          .padding(4)
          .focused($focused)
          .accessibilityLabel("vimrc")
        if draft.isEmpty {
          Text(Self.placeholder)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(Theme.faintText)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .allowsHitTesting(false)
        }
      }
      .frame(minHeight: 140)
      .background(Theme.background, in: RoundedRectangle(cornerRadius: 6))
      .overlay(RoundedRectangle(cornerRadius: 6).stroke(focused ? Theme.accent : Theme.separator))
      if draft.utf16.count >= SettingsRanges.vimrcLength {
        Text("The vimrc can have up to \(SettingsRanges.vimrcLength) characters.")
          .font(.caption)
          .foregroundStyle(Theme.warning)
      }
      if !model.vimrcProblems.isEmpty {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(model.vimrcProblems, id: \.self) { problem in
            Text("Line \(problem.line + 1): \(problem.message)")
          }
        }
        .font(.caption)
        .foregroundStyle(Theme.danger)
        .accessibilityIdentifier("vimrc-problems")
      }
    }
    .onAppear {
      draft = saved
      committed = saved
    }
    .onChange(of: saved) { _, value in
      guard value != committed else { return }
      committed = value
      draft = value
    }
    .onChange(of: draft) { _, value in
      if value.utf16.count > SettingsRanges.vimrcLength { draft = Self.truncated(value) }
    }
    .task(id: draft) {
      guard draft != committed else { return }
      try? await Task.sleep(for: Self.commitDelay)
      guard !Task.isCancelled else { return }
      commit()
    }
    .onChange(of: focused) { _, isFocused in
      if !isFocused { commit() }
    }
    .onDisappear { commit() }
  }

  private func commit() {
    let value = Self.truncated(draft)
    guard value != committed else { return }
    committed = value
    Task { await settings.update(SettingsPatch(editor: .init(vimrc: value))) }
  }

  /// At most `SettingsRanges.vimrcLength` UTF-16 units (the daemon's limit), whole characters.
  static func truncated(_ text: String) -> String {
    guard text.utf16.count > SettingsRanges.vimrcLength else { return text }
    var result = ""
    var count = 0
    for character in text {
      let length = String(character).utf16.count
      if count + length > SettingsRanges.vimrcLength { break }
      result.append(character)
      count += length
    }
    return result
  }
}
