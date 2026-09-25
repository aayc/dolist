import DailyDoListDomain
import DailyDoListModels
import SwiftUI

/// What the daily-notes settings would produce today, for live feedback while editing.
struct DailyNotePreview: Equatable {
  var path: String?
  var problems: [String]
  var templateMissing: Bool

  static func make(_ settings: DailyNoteSettings, files: Set<String>, today: LocalDate)
    -> DailyNotePreview
  {
    var problems: [String] = []
    if settings.folder.count > SettingsRanges.folderLength {
      problems.append("The folder is too long.")
    }
    if settings.format.count > SettingsRanges.formatLength {
      problems.append("The format is too long.")
    }
    if settings.template.count > SettingsRanges.templateLength {
      problems.append("The template path is too long.")
    }
    let path = DailyNotes.path(for: today, settings: settings)
    let name = VaultPath.stem(path)
    if name.isEmpty || VaultPath.isHidden(path) {
      problems.append("This format doesn't produce a valid note name.")
    } else if path == DailyNotes.path(for: today.adding(days: 1), settings: settings) {
      problems.append("This format gives every day the same file name.")
    } else if DailyNotes.date(forPath: path, settings: settings) != today {
      problems.append("Notes with this format won't be recognized as daily notes.")
    }
    let template = DailyNotes.templatePath(settings.template)
    return DailyNotePreview(
      path: problems.isEmpty || !name.isEmpty ? path : nil, problems: problems,
      templateMissing: template.map { !files.contains($0) } ?? false)
  }
}

/// Daily and weekly note locations, formats and templates.
struct DailyNotesSettingsPane: View {
  let model: AppModel
  let settings: SettingsStore
  @State private var draft = DailyNoteSettings.defaults

  var body: some View {
    let daily = settings.settings.dailyNotes
    let weekly = settings.settings.weeklyNotes
    let files = Set(model.workspace?.vault.files ?? [])
    let preview = DailyNotePreview.make(
      draft, files: files, today: LocalDate.today(now: model.environment.now()))
    Form {
      Section("Daily notes") {
        CommitTextField(title: "Folder", value: daily.folder, prompt: "Vault root") { folder in
          draft.folder = folder
          update(SettingsPatch(dailyNotes: .init(folder: folder)))
        }
        CommitTextField(
          title: "Date format", value: daily.format, prompt: "YYYY-MM-DD", monospaced: true
        ) { format in
          draft.format = format
          update(SettingsPatch(dailyNotes: .init(format: format)))
        }
        CommitTextField(title: "Template", value: daily.template, prompt: "No template") {
          template in
          draft.template = template
          update(SettingsPatch(dailyNotes: .init(template: template)))
        }
        if let path = preview.path {
          LabeledContent("Today's note") {
            Text(path).font(.system(.body, design: .monospaced)).textSelection(.enabled)
          }
        }
        ForEach(preview.problems, id: \.self) { SettingsNote(text: $0, tone: Theme.danger) }
        if preview.templateMissing {
          SettingsNote(
            text: "The template note isn't in the vault; new daily notes start empty.",
            tone: Theme.warning)
        }
        SettingsNote(
          text:
            "Moment.js tokens, e.g. YYYY-MM-DD or YYYY/MM/YYYY-MM-DD (nested folders). Same settings as Obsidian's daily notes."
        )
      }
      Section {
        CommitTextField(title: "Folder", value: weekly.folder, prompt: "Vault root") {
          update(SettingsPatch(weeklyNotes: .init(folder: $0)))
        }
        CommitTextField(
          title: "Format", value: weekly.format, prompt: "gggg-[W]ww", monospaced: true
        ) {
          update(SettingsPatch(weeklyNotes: .init(format: $0)))
        }
        CommitTextField(title: "Template", value: weekly.template, prompt: "No template") {
          update(SettingsPatch(weeklyNotes: .init(template: $0)))
        }
        LabeledContent("This week's note") {
          Text(
            DailyNotes.weeklyPath(
              for: LocalDate.today(now: model.environment.now()), settings: weekly)
          )
          .font(.system(.body, design: .monospaced))
        }
      } header: {
        HStack(spacing: 8) {
          Text("Weekly notes")
          CommandKeycaps(command: .weeklyNote)
        }
      }
      if !settings.isLoaded { NotConnectedNote() }
    }
    .formStyle(.grouped)
    .onAppear { draft = daily }
    .onChange(of: daily) { _, value in draft = value }
  }

  private func update(_ patch: SettingsPatch) {
    Task { await settings.update(patch) }
  }
}
