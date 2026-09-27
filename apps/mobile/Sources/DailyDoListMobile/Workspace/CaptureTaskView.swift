import DailyDoListMobileKit
import SwiftUI

struct CaptureTaskView: View {
  let workspace: PhoneWorkspace
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @State private var saving = false
  @State private var failure: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("What would you like to do?", text: $text, axis: .vertical).lineLimit(3...8)
            .accessibilityIdentifier("capture.text")
        } footer: {
          Text(
            "Saved for today's date on this iPhone, then delivered to \(workspace.profile.name).")
        }
        if !workspace.online {
          Text("Offline captures wait on this iPhone until this host reconnects.").font(.footnote)
        }
        if let failure { Text(failure).foregroundStyle(.red) }
      }
      .navigationTitle("Capture a task")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            saving = true
            Task {
              do {
                try await workspace.capture(text)
                dismiss()
              } catch { failure = error.localizedDescription }
              saving = false
            }
          }.disabled(saving || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("capture.save")
        }
      }
    }
  }
}

struct CaptureHistoryView: View {
  let workspace: PhoneWorkspace
  var body: some View {
    List {
      ForEach(workspace.captures.reversed()) { capture in
        VStack(alignment: .leading, spacing: 6) {
          Text(capture.operation.text)
          Text(capture.operation.localDate).font(.caption).foregroundStyle(.secondary)
          Text(status(capture)).font(.footnote).foregroundStyle(.secondary)
          if let receipt = capture.receipt, receipt.outcome == .applied, !receipt.watched {
            Text(
              "Saved outside the host's current watched dates. The agent may not act on this note."
            )
            .font(.footnote)
          }
          if capture.state == .queued, capture.attemptCount == 0 {
            Button("Cancel capture", role: .destructive) {
              Task { await workspace.cancelCapture(capture) }
            }
          }
          if let path = capture.receipt?.note?.path ?? capture.receipt?.path {
            Button("Open note") { Task { await workspace.open(path) } }
          }
        }.padding(.vertical, 4)
      }
    }
    .overlay {
      if workspace.captures.isEmpty {
        ContentUnavailableView("No captures yet", systemImage: "checklist")
      }
    }
    .navigationTitle("Captures")
    .task { await workspace.loadCaptures() }
  }
  private func status(_ capture: QueuedCapture) -> String {
    switch capture.state {
    case .queued: "Saved on iPhone · waiting to send"
    case .sending: "Checking whether the host saved this capture"
    case .applied: "Saved on the host"
    case .indeterminate: "Needs review · check the note before adding this again"
    case .reconciled: "Reviewed"
    case .cancelled: "Cancelled"
    }
  }
}
