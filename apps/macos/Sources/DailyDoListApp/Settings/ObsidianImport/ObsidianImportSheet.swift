import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Import from Obsidian, as a sheet over Settings → General: pick the Obsidian vault (a folder
/// picker), read the report, choose where the new vault goes, import with progress, then switch.
struct ObsidianImportSheet: View {
  let model: AppModel
  let imports: ObsidianImportStore
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("Import from Obsidian").font(.title3.weight(.semibold))
        Spacer()
      }
      .padding([.horizontal, .top], 20)
      .padding(.bottom, 12)
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          if let job = imports.currentImport {
            JobView(model: model, imports: imports, job: job)
          } else {
            steps
          }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      Divider()
      footer.padding(16)
    }
    .frame(width: 640, height: 660)
  }

  // MARK: - Before importing

  @ViewBuilder private var steps: some View {
    ImportStep(number: 1, title: "Your Obsidian vault") {
      Text(
        "Choose your Obsidian vault: the folder with .obsidian inside. Daily Do List only reads it, and copies it into a new vault, so Obsidian and Obsidian Sync go on using the original. If it's in iCloud Drive, download it first (Keep Downloaded)."
      )
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 10) {
        if let source = imports.source {
          Image(systemName: "folder").foregroundStyle(.secondary)
          Text(FolderPicker.display(source)).lineLimit(1).truncationMode(.middle)
            .tooltip(TooltipContent.path(source))
          Spacer()
          Button("Choose Another…") { chooseSource() }.pointingHandCursor()
        } else {
          Button("Choose Folder…") { chooseSource() }
            .buttonStyle(.borderedProminent)
            .pointingHandCursor()
            .disabled(imports.isForbidden)
            .tooltip(
              "Pick the Obsidian vault's folder",
              whenDisabled: ObsidianImportStore.pairedDeviceReason)
        }
        if imports.isBusy(.preview) { ProgressView().controlSize(.small) }
      }
      if let error = imports.error(.preview) { SettingsNote(text: error, tone: Theme.danger) }
    }
    if let preview = imports.preview {
      ImportStep(
        number: 2,
        title: preview.isObsidianVault
          ? "What comes over from the Obsidian vault" : "What comes over from the folder"
      ) {
        ImportReportView(preview: preview)
      }
      ImportStep(number: 3, title: "Where the new vault goes") {
        Text(
          "A new folder, or an empty one, outside the Obsidian vault. \(ImportText.count(preview.files, "file")) (\(ImportText.bytes(preview.bytes))) are copied into it as they are, so it still opens in Obsidian."
        )
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        HStack {
          @Bindable var imports = imports
          TextField("New vault folder", text: $imports.destination)
            .textFieldStyle(.roundedBorder)
            .font(.system(.body, design: .monospaced))
          Button("Choose…") { chooseDestination() }.pointingHandCursor()
            .tooltip("Pick or create an empty folder")
        }
        if let error = imports.error(.start) { SettingsNote(text: error, tone: Theme.danger) }
      }
    }
  }

  private func chooseSource() {
    guard let url = model.environment.chooseFolder("Choose your Obsidian vault", imports.source)
    else { return }
    Task { await imports.readReport(source: url.path) }
  }

  private func chooseDestination() {
    guard
      let url = model.environment.chooseFolder(
        "Choose or create an empty folder for the new vault", imports.destination)
    else { return }
    imports.destination = url.path
  }

  // MARK: - Footer

  @ViewBuilder private var footer: some View {
    HStack {
      if let job = imports.currentImport, job.state != .running {
        Button(job.state == .done ? "Import Another Vault" : "Start Over") { imports.startOver() }
          .pointingHandCursor()
      }
      Spacer()
      Button("Close") { dismiss() }
        .keyboardShortcut(.cancelAction)
        .pointingHandCursor()
        .tooltip(
          imports.isRunning ? "The import goes on; you'll be told when it's done" : "Close")
      if imports.currentImport == nil, imports.preview != nil {
        Button(imports.isBusy(.start) ? "Starting…" : "Import") {
          Task { await imports.startImport() }
        }
        .keyboardShortcut(.defaultAction)
        .buttonStyle(.borderedProminent)
        .pointingHandCursor()
        .disabled(
          imports.isBusy(.start) || imports.isRunning
            || imports.destination.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
  }
}

/// A running, finished, failed or cancelled import, and the switch once it's done.
private struct JobView: View {
  let model: AppModel
  let imports: ObsidianImportStore
  let job: ObsidianImportJob

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(
        SettingsCallout.inlineMarkdown(
          "From `\(FolderPicker.display(job.source))` into `\(FolderPicker.display(job.destination))`"
        )
      )
      .fixedSize(horizontal: false, vertical: true)
      switch job.state {
      case .running:
        ImportProgressRow(job: job) {
          Button(imports.isBusy(.cancel) ? "Cancelling…" : "Cancel") {
            Task { await imports.cancel() }
          }
          .pointingHandCursor()
          .disabled(imports.isBusy(.cancel))
          .tooltip("Stop, and remove what was copied so far")
        }
      case .done:
        if let result = job.result { done(result) }
      default:
        SettingsNote(
          text: (job.state == .failed
            ? "The import stopped: \(job.error ?? "an unexpected error")."
            : "The import was cancelled.")
            + " Nothing was left behind, and your vaults are as they were.",
          tone: Theme.danger)
      }
      if let error = imports.error(.cancel) { SettingsNote(text: error, tone: Theme.danger) }
    }
  }

  @ViewBuilder private func done(_ result: ObsidianImportResult) -> some View {
    Label {
      Text(
        "Imported. \(ImportText.count(result.copied.files, "file")) (\(ImportText.bytes(result.copied.bytes))) were copied, and your Daily Do List notes carried over."
      )
      .fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success)
    }
    DisclosureGroup("What was carried over") { CarryOverView(plan: result.carryOver) }
      .pointingHandCursor()
    ImportStep(number: nil, title: "Switch to the new vault") {
      Text(
        SettingsCallout.inlineMarkdown(
          "Daily Do List restarts on `\(FolderPicker.display(job.destination))` and reconnects. Your current vault stays at `\(FolderPicker.display(result.carryOver.vault))`, untouched: it's your backup."
        )
      )
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
      if let blocker = model.vaultSwitchBlocker {
        SettingsNote(text: blocker, tone: Theme.warning)
        if imports.syncs {
          Button("Open Sync Settings") { model.showAlwaysOnSettings(.sync) }
            .pointingHandCursor()
            .tooltip("Settings → Always-On → Sync")
        }
      }
      HStack {
        Button(imports.isBusy(.switchVault) ? "Switching…" : "Switch to the New Vault") {
          Task { await model.switchVault(to: job.destination) }
        }
        .buttonStyle(.borderedProminent)
        .pointingHandCursor()
        .disabled(model.vaultSwitchBlocker != nil || imports.isBusy(.switchVault))
        .tooltip(
          "Restart on the new vault", whenDisabled: model.vaultSwitchBlocker ?? "Switching…")
        if imports.syncs {
          Button("Check Again") { Task { await imports.refreshStatus() } }.pointingHandCursor()
        }
      }
      if let error = imports.error(.switchVault) { SettingsNote(text: error, tone: Theme.danger) }
    }
  }
}

/// A numbered step of the flow.
private struct ImportStep<Content: View>: View {
  let number: Int?
  let title: String
  @ViewBuilder let content: Content

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      if let number {
        Text("\(number)")
          .font(.caption.weight(.semibold))
          .frame(width: 20, height: 20)
          .background(Theme.accent.opacity(0.2), in: Circle())
      }
      VStack(alignment: .leading, spacing: 8) {
        Text(title).font(.headline)
        content
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
