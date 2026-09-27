import DailyDoListDomain
import DailyDoListMobileKit
import SwiftUI

struct PhoneNoteRecoveryView: View {
  let workspace: PhoneWorkspace
  let path: String
  @State private var snapshot: NoteReviewSnapshot?
  @State private var recoveryPath = ""
  @State private var busy = false
  @State private var failure: String?

  var body: some View {
    Form {
      if let snapshot {
        Section("Saved on this iPhone") {
          Text(snapshot.note.content).font(.system(.body, design: .monospaced)).textSelection(
            .enabled)
          Button("Review in editor") { Task { await workspace.open(path) } }
        }
        if let host = snapshot.hostContent {
          Section("Last downloaded host version") {
            Text(host).font(.system(.body, design: .monospaced)).textSelection(.enabled)
          }
        }
        Section("Resolve") {
          if snapshot.note.reviewReason == .overlappingEdits {
            Button("Keep reviewed iPhone text and sync") { resolve(.keep, snapshot: snapshot) }
          }
          if snapshot.hostContent != nil && snapshot.note.state == .needsReview {
            Button("Use downloaded host version") { resolve(.host, snapshot: snapshot) }
            Text("Your current iPhone text remains available in the recovery export.").font(
              .footnote)
          }
          TextField("New note path", text: $recoveryPath).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Save as a separate recovery note") { resolve(.copy, snapshot: snapshot) }
            .disabled(recoveryPath.isEmpty)
        }.disabled(busy)
      }
      if let failure { Text(failure).foregroundStyle(.red) }
    }
    .navigationTitle("Review note")
    .task { await load() }
    .refreshable { await load() }
  }

  private enum Resolution { case keep, host, copy }
  private func resolve(_ resolution: Resolution, snapshot: NoteReviewSnapshot) {
    busy = true
    Task {
      let session = workspace.sessions[path]
      session?.finishComposition()
      session?.setStructureLocked(true)
      defer {
        session?.setStructureLocked(false)
        busy = false
      }
      do {
        await session?.checkpoint()
        let saved: LocalNote
        switch resolution {
        case .keep:
          saved = try await workspace.repository.keepMergedEdits(
            path: path, expectedRevision: snapshot.note.localRevision)
        case .host:
          saved = try await workspace.repository.useRemoteVersion(
            path: path, expectedRevision: snapshot.note.localRevision)
        case .copy:
          saved = try await workspace.repository.recover(
            path: path, as: VaultPath.ensureMarkdownExtension(recoveryPath),
            expectedRevision: snapshot.note.localRevision)
        }
        if resolution == .copy {
          await workspace.open(saved.path, newTab: true)
        } else {
          session?.adoptReviewed(saved)
        }
        await load()
        await workspace.synchronize()
      } catch {
        failure =
          "The note may have changed since this review. Refresh and check it again. \(error.localizedDescription)"
      }
    }
  }

  private func load() async {
    do {
      snapshot = try await workspace.repository.review(path)
      if recoveryPath.isEmpty { recoveryPath = VaultPath.stem(path) + " recovered.md" }
    } catch { failure = error.localizedDescription }
  }
}
