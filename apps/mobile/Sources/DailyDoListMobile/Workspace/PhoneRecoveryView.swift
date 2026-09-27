import DailyDoListAgentCore
import DailyDoListMobileKit
import SwiftUI
import UIKit

struct PhoneRecoveryView: View {
  let workspace: PhoneWorkspace
  @State private var notes: [LocalNote] = []
  @State private var exporting = false
  @State private var exported: RecoveryExportResult?
  @State private var showExport = false
  @State private var failure: String?

  var body: some View {
    List {
      Section("Local notes needing review") {
        ForEach(notes, id: \.path) { note in
          NavigationLink(note.path) { PhoneNoteRecoveryView(workspace: workspace, path: note.path) }
        }
        if notes.isEmpty { Text("No note conflicts").foregroundStyle(.secondary) }
      }
      Section("Moves and deletions") {
        ForEach(workspace.structuralOperations) { operation in
          NavigationLink(operation.action.source) {
            PhoneStructureReview(workspace: workspace, operation: operation)
          }
        }
        if workspace.structuralOperations.isEmpty {
          Text("No uncertain changes").foregroundStyle(.secondary)
        }
      }
      if let store = workspace.agent, !store.pendingMutations.isEmpty {
        Section("Agent actions awaiting confirmation") {
          ForEach(store.pendingMutations) { operation in
            VStack(alignment: .leading, spacing: 8) {
              Text(label(operation.command)).font(.headline)
              Text(operation.createdAt, style: .date).font(.caption)
              Text(
                "The original request may have reached the host. Checking its receipt will not send it again."
              ).font(.footnote).foregroundStyle(.secondary)
              Button("Check original receipt") {
                Task { _ = await store.resolveMutation(operation.id) }
              }.disabled(!workspace.online)
            }
          }
        }
      }
      Section("Export") {
        Button("Export local recovery files", systemImage: "square.and.arrow.up") {
          exporting = true
          Task {
            do {
              await workspace.checkpointAll(finishComposition: true)
              await workspace.composerDrafts.flush()
              exported = try await workspace.recovery.export(
                to: FileManager.default.temporaryDirectory)
              showExport = true
            } catch { failure = error.localizedDescription }
            exporting = false
          }
        }.disabled(exporting)
        Text(
          "Includes local notes, bases, recovery copies, unsent reply drafts and captures. Save the folder in Files before removing this connection."
        ).font(.footnote).foregroundStyle(.secondary)
        if let exported, exported.manifest.unsupportedRecordCount > 0 {
          Text(
            "This export has \(exported.manifest.unsupportedRecordCount) protected records it cannot yet include. Keep this connection until those actions are resolved."
          ).font(.footnote).foregroundStyle(.orange)
        }
      }
      if let failure { Text(failure).foregroundStyle(.red) }
    }
    .navigationTitle("Recovery")
    .task {
      do {
        notes = try await workspace.repository.notes().filter {
          $0.state == .needsReview || $0.state == .recoveryDraft
        }
      } catch { failure = error.localizedDescription }
      await workspace.agent?.refreshPendingMutations()
    }
    .sheet(isPresented: $showExport) {
      if let exported { WorkspaceExportPicker(url: exported.directory) }
    }
  }

  private func label(_ command: AgentMutationCommand) -> String {
    switch command {
    case .message(_, let text): "Send: \(text)"
    case .cancelThread: "Stop task"
    case .retryThread: "Retry task"
    case .approval(_, let decision): "Approval decision: \(decision.decision.rawValue)"
    case .createRoutine: "Create routine"
    case .runRoutine: "Run routine"
    case .pauseRoutine: "Pause routine"
    case .resumeRoutine: "Resume routine"
    }
  }
}

private struct WorkspaceExportPicker: UIViewControllerRepresentable {
  let url: URL
  func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
    UIDocumentPickerViewController(forExporting: [url], asCopy: true)
  }
  func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}
}

private struct PhoneStructureReview: View {
  let workspace: PhoneWorkspace
  let operation: WorkspaceStructuralOperation
  @State private var inspection: String?
  @State private var inspectedGeneration: UInt64?
  var body: some View {
    Form {
      Section("Original request") {
        LabeledContent("Source", value: operation.action.source)
        if let destination = operation.action.destination {
          LabeledContent("Destination", value: destination)
        }
        Text(
          "This request is never sent again automatically. Check the host before confirming what happened; matching content alone does not prove a move."
        )
      }
      Section("Inspect the host") {
        Button("Refresh current paths") {
          Task {
            let epoch = workspace.generation
            do {
              guard let client = workspace.client, workspace.online else { return }
              let tree = try await client.tree()
              guard epoch == workspace.generation, workspace.online else { return }
              let paths = Set(tree.entries.map(\.path))
              inspection =
                "Source: \(paths.contains(operation.action.source) ? "present" : "absent")"
              if let destination = operation.action.destination {
                inspection! +=
                  "\nDestination: \(paths.contains(destination) ? "present" : "absent")"
              }
              inspectedGeneration = epoch
            } catch {
              inspection = error.localizedDescription
              inspectedGeneration = nil
            }
          }
        }.disabled(!workspace.online)
        if let inspection { Text(inspection) }
        Button("Open source") { Task { await workspace.open(operation.action.source) } }
        if let destination = operation.action.destination {
          Button("Open destination") { Task { await workspace.open(destination) } }
        }
      }
      Section("After checking") {
        Button("I confirmed the change happened") {
          Task { await workspace.resolveStructure(operation, as: .applied) }
        }
        Button("I confirmed the change did not happen") {
          Task { await workspace.resolveStructure(operation, as: .notApplied) }
        }
      }.disabled(!workspace.online || inspectedGeneration != workspace.generation)
    }.navigationTitle("Review host change")
  }
}
