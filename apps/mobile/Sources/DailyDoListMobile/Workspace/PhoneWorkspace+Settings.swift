import DailyDoListEditorCore
import DailyDoListModels
import Foundation

extension PhoneWorkspace {
  func adoptSettings(_ settings: AppSettings) async {
    self.settings = settings
    configureEditors()
    do {
      let revision = try await cache.settings()?.revision
      try await cache.storeSettings(settings, replacing: revision)
      await downloadPeriodicTemplates()
    } catch { self.error = error.localizedDescription }
  }

  func configureEditors() {
    for session in sessions.values { configureEditor(session) }
  }

  func configureEditor(_ session: NoteSession) {
    guard let settings else { return }
    let editor = settings.editor
    session.editor.updateConfiguration(
      EditorConfiguration(
        fontSize: editor.fontSize, livePreview: editor.livePreview,
        readableLineLength: editor.readableLineLength, spellcheck: editor.spellcheck,
        showLineNumbers: editor.showLineNumbers,
        isEditable: session.editor.configuration.isEditable,
        vimMode: false))
  }
}
