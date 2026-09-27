import DailyDoListMobileKit
import SwiftUI

struct PhoneCaptureReviewView: View {
  let workspace: PhoneWorkspace
  let capture: QueuedCapture
  @State private var inspection: CaptureInspection?
  @State private var inspectedGeneration: UInt64?
  @State private var busy = false
  @State private var confirm = false
  @State private var reviewed = false
  @State private var failure: String?

  var body: some View {
    Form {
      Section("Original capture") {
        Text(capture.operation.text).textSelection(.enabled)
        LabeledContent("Date", value: capture.operation.localDate)
        LabeledContent("Time zone", value: capture.operation.timeZone)
        Text(capture.id.uuidString).font(.caption.monospaced()).textSelection(.enabled)
        Text(
          "The host cannot prove whether this request was saved. It will never append this request again. Compare the current note with your original text before deciding whether you need to add a new task."
        )
        .font(.footnote).foregroundStyle(.secondary)
      }
      Section("Current host note") {
        Button("Load note for review", systemImage: "arrow.clockwise") { inspect() }
          .disabled(!workspace.online || busy || reviewed)
          .accessibilityIdentifier("capture.review.inspect")
        if let inspection, inspectedGeneration == workspace.generation {
          Text(inspection.path).font(.caption).foregroundStyle(.secondary)
          if let note = inspection.note {
            Text(note.content.isEmpty ? "The note is empty." : note.content)
              .font(.body.monospaced()).textSelection(.enabled)
          } else {
            Text("The host currently has no note at this path.")
          }
          Text("Matching text does not prove that this particular request was saved.")
            .font(.footnote).foregroundStyle(.secondary)
        }
      }
      Section {
        Button("I have reviewed this capture") { confirm = true }
          .disabled(
            reviewed || busy || !workspace.online || inspection == nil
              || inspectedGeneration != workspace.generation
          )
          .accessibilityIdentifier("capture.review.confirm")
        if reviewed { Label("Reviewed — no new task was sent", systemImage: "checkmark.circle") }
      } footer: {
        Text(
          "Review removes this capture's sync barrier. Its original text stays in capture history.")
      }
      if busy { ProgressView() }
      if let failure { Text(failure).foregroundStyle(.red) }
    }
    .navigationTitle("Review capture")
    .confirmationDialog(
      "Mark this capture as reviewed?", isPresented: $confirm, titleVisibility: .visible
    ) {
      Button("Mark reviewed") {
        guard let inspection, workspace.online, inspectedGeneration == workspace.generation else {
          return
        }
        busy = true
        Task {
          do {
            try await workspace.captureOutbox.markReconciled(afterReview: inspection)
            reviewed = true
            await workspace.loadCaptures()
            await workspace.synchronize()
          } catch { failure = error.localizedDescription }
          busy = false
        }
      }
    } message: {
      Text(
        "This does not resend the capture. You can deliberately create a new capture later if needed."
      )
    }
  }

  private func inspect() {
    guard let remote = workspace.remote, workspace.online else { return }
    let epoch = workspace.generation
    busy = true
    inspection = nil
    failure = nil
    Task {
      do {
        let value = try await workspace.captureOutbox.inspectIndeterminate(
          capture.id,
          replacing: capture.revision, with: remote)
        guard workspace.online, workspace.generation == epoch else {
          busy = false
          return
        }
        inspection = value
        inspectedGeneration = epoch
      } catch { failure = error.localizedDescription }
      busy = false
    }
  }
}
