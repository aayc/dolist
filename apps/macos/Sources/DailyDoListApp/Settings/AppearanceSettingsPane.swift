import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Theme and editor appearance (stored by the daemon, applied live).
struct AppearanceSettingsPane: View {
  let model: AppModel
  let settings: SettingsStore
  @State private var fontSize: Double = EditorSettings.defaults.fontSize

  var body: some View {
    let editor = settings.settings.editor
    Form {
      Section("Theme") {
        LabeledContent("Appearance") {
          Picker(
            "Appearance",
            selection: Binding(
              get: { settings.settings.theme },
              set: { theme in update(SettingsPatch(theme: theme)) })
          ) {
            Text("System").tag(ThemePreference.system)
            Text("Light").tag(ThemePreference.light)
            Text("Dark").tag(ThemePreference.dark)
          }
          .pickerStyle(.segmented)
          .labelsHidden()
          .pointingHandCursor()
        }
      }
      Section("Editor") {
        LabeledContent("Font size") {
          HStack {
            Slider(value: $fontSize, in: SettingsRanges.fontSize, step: 1) { editing in
              if !editing { commitFontSize() }
            }
            .frame(width: 220)
            Text("\(Int(fontSize)) pt").monospacedDigit().frame(width: 44, alignment: .trailing)
          }
        }
        SettingsToggle(
          "Live preview", isOn: editorBinding(editor.livePreview) { .init(livePreview: $0) })
        SettingsNote(text: "Hide markdown syntax away from the cursor, like Obsidian.")
        SettingsToggle(
          "Readable line length",
          isOn: editorBinding(editor.readableLineLength) { .init(readableLineLength: $0) })
        SettingsToggle(
          "Spellcheck", isOn: editorBinding(editor.spellcheck) { .init(spellcheck: $0) })
        SettingsToggle(
          "Line numbers", isOn: editorBinding(editor.showLineNumbers) { .init(showLineNumbers: $0) }
        )
        SettingsToggle(
          "Vim key bindings", isOn: editorBinding(editor.vimMode) { .init(vimMode: $0) })
        SettingsNote(text: "Edit with vim's modes and commands, like Obsidian's vim key bindings.")
        if editor.vimMode {
          VimrcEditor(model: model, settings: settings)
        }
      }
      if !settings.isLoaded { NotConnectedNote() }
    }
    .formStyle(.grouped)
    .onAppear { fontSize = editor.fontSize }
    .onChange(of: editor.fontSize) { _, value in fontSize = value }
  }

  private func commitFontSize() {
    let value = min(
      SettingsRanges.fontSize.upperBound,
      max(SettingsRanges.fontSize.lowerBound, fontSize.rounded()))
    guard value != settings.settings.editor.fontSize else { return }
    update(SettingsPatch(editor: .init(fontSize: value)))
  }

  private func editorBinding(_ value: Bool, _ patch: @escaping (Bool) -> SettingsPatch.EditorPatch)
    -> Binding<Bool>
  {
    Binding(get: { value }, set: { update(SettingsPatch(editor: patch($0))) })
  }

  private func update(_ patch: SettingsPatch) {
    Task { await settings.update(patch) }
  }
}
