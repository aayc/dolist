import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Settings → General → Vault, under the vault picker: the vault the daemon opens, Import from
/// Obsidian (a sheet), and once this vault was imported, Update from Obsidian and the old vault.
struct VaultSettingsSection: View {
  let model: AppModel
  let imports: ObsidianImportStore

  var body: some View {
    Section("Vault") {
      if model.client == nil {
        NotConnectedNote()
      } else if imports.isUnsupported {
        SettingsNote(
          text: "This daemon can't import from Obsidian yet. Update it to import here.")
      } else {
        if imports.isForbidden {
          SettingsNote(text: ObsidianImportStore.pairedDeviceReason, tone: Theme.warning)
        } else if let error = imports.error(.load) {
          SettingsNote(text: error, tone: Theme.danger)
        }
        if let vault = imports.vault {
          LabeledContent("Opened") {
            Text(FolderPicker.display(vault.path))
              .lineLimit(1)
              .truncationMode(.middle)
              .textSelection(.enabled)
              .tooltip(TooltipContent.path(vault.path))
          }
        }
        if let imported = imports.imported {
          ImportedFromRows(model: model, imports: imports, imported: imported)
        }
        LabeledContent {
          Button("Import from Obsidian…") { model.showImportFromObsidian() }
            .pointingHandCursor()
            .disabled(model.isDemo || imports.isForbidden)
            .tooltip(
              "Import from Obsidian", command: .importFromObsidian,
              whenDisabled: model.isDemo
                ? "The demo can't import vaults" : ObsidianImportStore.pairedDeviceReason)
        } label: {
          VStack(alignment: .leading, spacing: 2) {
            Text("Moving from Obsidian?")
            Text(
              "Makes a new vault from your Obsidian vault, with your notes, routines and agent history carried over. You see a report before anything is copied."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
  }
}

/// Where the vault came from, Update from Obsidian with its progress and report, and the backup.
private struct ImportedFromRows: View {
  let model: AppModel
  let imports: ObsidianImportStore
  let imported: ObsidianImportOrigin

  var body: some View {
    LabeledContent {
      Button(imports.isBusy(.update) ? "Starting…" : "Update from Obsidian") {
        Task { await imports.update() }
      }
      .pointingHandCursor()
      .disabled(imports.isRunning || imports.isBusy(.update) || imports.isForbidden)
      .tooltip(
        "Copy what changed in Obsidian since the import", command: .updateFromObsidian,
        whenDisabled: "An import or update is running")
    } label: {
      VStack(alignment: .leading, spacing: 2) {
        Text("Imported from Obsidian")
        Text(originText).font(.caption).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    SettingsNote(
      text:
        "Still writing in Obsidian, or on your phone with Obsidian Sync? Update from Obsidian copies what changed there since the import. It never deletes anything, and keeps both versions of a note changed in both places. Tasks it brings in are new to the agent: it picks them up as if you had just written them."
    )
    if let update = imports.currentUpdate {
      UpdateJobRows(imports: imports, job: update)
    }
    if let error = imports.error(.update) ?? imports.error(.cancel) {
      SettingsNote(text: error, tone: Theme.danger)
    }
    if let previous = imported.previousVault {
      LabeledContent {
        Button("Reveal in Finder") { model.revealPreviousVault() }
          .pointingHandCursor()
          .disabled(model.previousVaultURL == nil)
          .tooltip(
            "Reveal the old vault in Finder", command: .revealPreviousVault,
            whenDisabled: "It isn't on this Mac")
      } label: {
        VStack(alignment: .leading, spacing: 2) {
          Text("Previous vault")
          Text("\(FolderPicker.display(previous)), kept untouched: it's your backup.")
            .font(.caption).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private var originText: String {
    var text =
      "From \(FolderPicker.display(imported.source)) on \(ImportText.day(imported.importedAt))"
    if let updated = imported.updatedAt { text += "; last updated \(ImportText.day(updated))" }
    return text + "."
  }
}

/// A running update's progress, or what it did.
private struct UpdateJobRows: View {
  let imports: ObsidianImportStore
  let job: ObsidianImportJob

  var body: some View {
    switch job.state {
    case .running:
      ImportProgressRow(job: job) {
        Button("Cancel") { Task { await imports.cancel() } }
          .pointingHandCursor()
          .disabled(imports.isBusy(.cancel))
          .tooltip("Stop; the files already copied stay")
      }
    case .done:
      if let report = job.update { UpdateReportView(report: report) }
    case .failed:
      SettingsNote(
        text: "The update stopped: \(job.error ?? "an unexpected error").", tone: Theme.danger)
    default:
      SettingsNote(text: "The update was cancelled; the files it had copied stay.")
    }
  }
}

/// A job's phase, counts and progress bar, with its Cancel button.
struct ImportProgressRow<Actions: View>: View {
  let job: ObsidianImportJob
  @ViewBuilder let actions: Actions

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(ImportText.phase(job.phase))
        Spacer()
        Text(ImportText.progress(job)).font(.caption).foregroundStyle(.secondary).monospacedDigit()
      }
      HStack(spacing: 10) {
        ProgressView(value: ImportText.fraction(job))
        actions
      }
    }
  }
}
