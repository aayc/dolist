import DailyDoListMobileKit
import SwiftUI

struct PhoneForgetConnectionView: View {
  let workspace: PhoneWorkspace
  /// Must checkpoint editors/composers and throw if any in-memory work remains unpersisted.
  let prepare: @MainActor () async throws -> Void
  /// The owner stops authority, calls conditional/clean recovery.forget, then removes credentials.
  let forget: @MainActor (WorkspaceScope, VerifiedRecoveryExport?) async throws -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var summary: WorkspaceRecoverySummary?
  @State private var exported: RecoveryExportResult?
  @State private var proof: VerifiedRecoveryExport?
  @State private var showExport = false
  @State private var confirm = false
  @State private var busy = false
  @State private var failure: String?

  var body: some View {
    Form {
      Section("This iPhone") {
        Text(workspace.profile.name).font(.headline)
        Text(
          "Forgetting removes this connection and its saved files from this iPhone. Files on the host remain available."
        )
        .font(.footnote)
        if let summary {
          LabeledContent("Local notes and drawings", value: "\(summary.notes)")
          LabeledContent("Unsent reply drafts", value: "\(summary.composers)")
          LabeledContent("Pending captures", value: "\(summary.captures)")
          LabeledContent("Uncertain moves or deletions", value: "\(summary.structuralOperations)")
          LabeledContent("Unconfirmed agent actions", value: "\(summary.agentOperations)")
          if summary.unknownRecords > 0 {
            Text(
              "Some protected records cannot be exported by this version. Keep this connection until they can be recovered."
            )
            .foregroundStyle(.orange)
          }
        } else {
          ProgressView("Checking local work")
        }
      }
      Section("Save a recovery copy") {
        Text(
          "Export preserves original text, drawings, captures and the exact requests for uncertain agent actions. It never replays an action. Save the folder in Files; the app then reads it back to verify every file."
        )
        .font(.footnote)
        Button("Export recovery folder", systemImage: "square.and.arrow.up") { export() }
          .disabled(busy || summary == nil)
          .accessibilityIdentifier("forget.export")
        if proof != nil {
          Label("Recovery copy verified", systemImage: "checkmark.shield")
            .foregroundStyle(.green)
        }
      }
      Section {
        Button("Forget connection", role: .destructive) { confirm = true }
          .disabled(
            busy || summary == nil || summary?.unknownRecords != 0
              || (summary?.requiresDecision == true && proof == nil)
          )
          .accessibilityIdentifier("forget.confirm")
      } footer: {
        Text("New work saved after an export requires a fresh recovery copy before removal.")
      }
      if busy { ProgressView() }
      if let failure { Text(failure).foregroundStyle(.red) }
    }
    .navigationTitle("Forget connection")
    .interactiveDismissDisabled(busy)
    .task { await refresh() }
    .sheet(isPresented: $showExport) {
      if let exported {
        WorkspaceExportPicker(url: exported.directory) { destination in
          showExport = false
          guard let destination else { return }
          busy = true
          Task {
            do {
              proof = try await workspace.recovery.verifyExport(exported, at: destination)
            } catch { failure = error.localizedDescription }
            busy = false
          }
        }
      }
    }
    .confirmationDialog(
      "Forget \(workspace.profile.name) from this iPhone?", isPresented: $confirm,
      titleVisibility: .visible
    ) {
      Button("Forget connection", role: .destructive) {
        busy = true
        Task {
          do {
            try await prepare()
            try await forget(workspace.recovery.scope, proof)
            dismiss()
          } catch {
            failure = error.localizedDescription
            if (error as? WorkspaceMaintenanceError) == .exportChanged { proof = nil }
          }
          busy = false
        }
      }
    } message: {
      Text(
        proof == nil
          ? "The local cache will be removed."
          : "Protected local work will remain in your verified recovery folder.")
    }
  }

  private func refresh() async {
    busy = true
    do {
      try await prepare()
      summary = try await workspace.recovery.summary()
    } catch { failure = error.localizedDescription }
    busy = false
  }

  private func export() {
    busy = true
    proof = nil
    failure = nil
    Task {
      do {
        try await prepare()
        exported = try await workspace.recovery.export(to: FileManager.default.temporaryDirectory)
        summary = try await workspace.recovery.summary()
        showExport = true
      } catch { failure = error.localizedDescription }
      busy = false
    }
  }
}
