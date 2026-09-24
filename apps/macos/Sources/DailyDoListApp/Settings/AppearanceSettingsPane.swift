import DailyDoListModels
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
        Picker("Appearance", selection: Binding(
          get: { settings.settings.theme },
          set: { theme in update(SettingsPatch(theme: theme)) })
        ) {
          Text("System").tag(ThemePreference.system)
          Text("Light").tag(ThemePreference.light)
          Text("Dark").tag(ThemePreference.dark)
        }
        .pickerStyle(.segmented)
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
        Toggle("Live preview", isOn: editorBinding(editor.livePreview) { .init(livePreview: $0) })
        SettingsNote(text: "Hide markdown syntax away from the cursor, like Obsidian.")
        Toggle("Readable line length", isOn: editorBinding(editor.readableLineLength) { .init(readableLineLength: $0) })
        Toggle("Spellcheck", isOn: editorBinding(editor.spellcheck) { .init(spellcheck: $0) })
        Toggle("Line numbers", isOn: editorBinding(editor.showLineNumbers) { .init(showLineNumbers: $0) })
      }
      if !settings.isLoaded { NotConnectedNote() }
    }
    .formStyle(.grouped)
    .onAppear { fontSize = editor.fontSize }
    .onChange(of: editor.fontSize) { _, value in fontSize = value }
  }

  private func commitFontSize() {
    let value = min(SettingsRanges.fontSize.upperBound, max(SettingsRanges.fontSize.lowerBound, fontSize.rounded()))
    guard value != settings.settings.editor.fontSize else { return }
    update(SettingsPatch(editor: .init(fontSize: value)))
  }

  private func editorBinding(_ value: Bool, _ patch: @escaping (Bool) -> SettingsPatch.EditorPatch) -> Binding<Bool> {
    Binding(get: { value }, set: { update(SettingsPatch(editor: patch($0))) })
  }

  private func update(_ patch: SettingsPatch) {
    Task { await settings.update(patch) }
  }
}
