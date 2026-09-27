import DailyDoListDrawingModel
import DailyDoListMobileKit
import SwiftUI

struct PhoneDrawingRecoveryView: View {
  let workspace: PhoneWorkspace
  let path: String
  @State private var snapshot: DrawingReviewSnapshot?
  @State private var recoveryPath = ""
  @State private var busy = false
  @State private var failure: String?

  var body: some View {
    Form {
      if let snapshot {
        Section("Saved on this iPhone") {
          Text(snapshot.drawing.content).font(.system(.caption, design: .monospaced))
            .textSelection(.enabled)
          Button("Review on canvas") { Task { await workspace.open(path) } }
        }
        if let host = snapshot.hostContent {
          Section("Last downloaded host version") {
            Text(host).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
          }
        }
        Section("Resolve") {
          if snapshot.hostContent != nil && snapshot.drawing.state == .needsReview {
            Button("Use downloaded host version") { resolve(copy: false, snapshot: snapshot) }
            Text("Your current iPhone drawing remains available in the recovery export.")
              .font(.footnote)
          }
          if snapshot.drawing.canEdit {
            TextField("New drawing path", text: $recoveryPath)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Save as a separate recovery drawing") {
              resolve(copy: true, snapshot: snapshot)
            }.disabled(recoveryPath.isEmpty)
          } else {
            Text("Export the original file, or repair it on the host and download it again.")
          }
        }.disabled(busy)
      }
      if let failure { Text(failure).foregroundStyle(.red) }
    }
    .navigationTitle("Review drawing")
    .task { await load() }
    .refreshable { await load() }
  }

  private func resolve(copy: Bool, snapshot: DrawingReviewSnapshot) {
    busy = true
    Task {
      defer { busy = false }
      do {
        let saved = try await workspace.resolveDrawingReview(
          snapshot, recoveryPath: copy ? recoveryPath : nil)
        if copy {
          await workspace.open(saved.path, newTab: true)
        }
        await load()
        await workspace.synchronize()
      } catch {
        failure = "Refresh and review the drawing again. \(error.localizedDescription)"
      }
    }
  }

  private func load() async {
    do {
      snapshot = try await workspace.drawingRepository.review(path)
      if recoveryPath.isEmpty {
        recoveryPath =
          String(path.dropLast(DrawingFileName.fileExtension.count))
          + " recovered" + DrawingFileName.fileExtension
      }
      failure = nil
    } catch { failure = error.localizedDescription }
  }
}

extension PhoneWorkspace {
  func resolveDrawingReview(_ snapshot: DrawingReviewSnapshot, recoveryPath: String? = nil)
    async throws -> LocalDrawing
  {
    guard !structuralBusy else { throw WorkspaceMaintenanceError.dirtyAffectedNotes }
    structuralBusy = true
    defer { structuralBusy = false }
    let path = snapshot.drawing.path
    let session = drawingSessions[path]
    let wasEditing = session?.controller.isEditing
    session?.controller.finishEditing()
    session?.controller.isEditing = false
    defer {
      if let session {
        session.controller.isEditing = wasEditing == true && session.drawing.canEdit
      }
    }
    await session?.checkpoint()
    try PhoneRecoveryPreparation.validate(notes: [], drawings: session.map { [$0] } ?? [])
    if let recoveryPath {
      return try await drawingRepository.recover(
        path: path, as: recoveryPath, expectedRevision: snapshot.drawing.localRevision)
    }
    let saved = try await drawingRepository.useRemoteVersion(
      path: path, expectedRevision: snapshot.drawing.localRevision)
    session?.adoptReviewed(saved)
    return saved
  }
}
