#if canImport(UIKit)
  import DailyDoListAgentCore
  import DailyDoListModels
  import SwiftUI

  /// A decision sheet always identifies the connected host and the exact proposed tool input.
  /// Decisions are sent only while this workspace has current authenticated authority.
  public struct MobileApprovalCard: View {
    let store: AgentStore
    let approval: ApprovalRequest
    let actionsEnabled: Bool
    let hostName: String?
    @State private var review: Review?
    @State private var denyNote = ""

    private struct Review: Identifiable {
      let approval: ApprovalRequest
      let decision: ApprovalDecision
      let scope: ApprovalScope
      let runner: AgentRunsOn?
      let host: String
      var id: String { approval.id }
    }

    public init(
      store: AgentStore, approval: ApprovalRequest, actionsEnabled: Bool = false,
      hostName: String? = nil
    ) {
      self.store = store
      self.approval = approval
      self.actionsEnabled = actionsEnabled
      self.hostName = hostName
    }

    private var isSending: Bool { store.decidingApprovalIds.contains(approval.id) }
    private var unavailable: String? {
      if !actionsEnabled { return "Reconnect to review and decide this action." }
      return store.readOnly?.reason
    }

    public var body: some View {
      let runner = store.placement?.runsOn
      let host = runner?.name ?? hostName ?? "Connected host"
      VStack(alignment: .leading, spacing: 12) {
        Label("Approval", systemImage: approval.status.systemImage).font(.headline)
        Text(approval.summary).font(.headline).textSelection(.enabled)
        Label(approval.risk.displayLabel, systemImage: "exclamationmark.shield")
          .foregroundStyle(approval.risk.tone.mobileColor)
        if !approval.categories.isEmpty {
          Text(approval.categories.map(\.displayLabel).joined(separator: " · ")).font(.caption)
        }
        Text(approval.reason).font(.subheadline)
        LabeledContent("Host", value: host)
        LabeledContent("Tool", value: approval.toolLabel ?? approval.toolName)
        DisclosureGroup("Exact input") { MobileJSONView(text: approval.input.prettyJSONString) }
        if isSending {
          ProgressView("Sending your decision…")
        } else if approval.isPending {
          if let expires = approval.expiresAt {
            Text(AgentFormat.expiry(expires)).font(.caption).foregroundStyle(.secondary)
          }
          if let unavailable { Text(unavailable).font(.caption).foregroundStyle(.secondary) }
          ViewThatFits {
            HStack { buttons(runner: runner, host: host) }
            VStack(alignment: .leading) { buttons(runner: runner, host: host) }
          }
          .disabled(unavailable != nil)
        } else {
          Text(AgentFormat.decision(of: approval) ?? approval.status.rawValue)
            .font(.subheadline.weight(.semibold))
          if let note = approval.decisionNote { Text(note).font(.subheadline) }
        }
      }
      .padding()
      .background(
        approval.risk.tone.mobileColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 14)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 14).strokeBorder(approval.risk.tone.mobileColor.opacity(0.4))
      )
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("approval.\(approval.id)")
      .sheet(item: $review) { reviewed in reviewSheet(reviewed) }
    }

    @ViewBuilder private func buttons(runner: AgentRunsOn?, host: String) -> some View {
      Button("Approve once") { send(approval, decision: .approve, scope: .once, runner: runner) }
        .buttonStyle(.borderedProminent)
      Menu("More") {
        Button("Approve for this task…") {
          review = Review(
            approval: approval, decision: .approve, scope: .task, runner: runner, host: host)
        }
        Button("Always approve this action…") {
          review = Review(
            approval: approval, decision: .approve, scope: .always, runner: runner, host: host)
        }
      }
      .buttonStyle(.bordered)
      Button("Deny…", role: .destructive) {
        denyNote = ""
        review = Review(
          approval: approval, decision: .deny, scope: .once, runner: runner, host: host)
      }
      .buttonStyle(.bordered)
    }

    private func reviewSheet(_ reviewed: Review) -> some View {
      NavigationStack {
        Form {
          Section("Action on \(reviewed.host)") {
            Text(reviewed.approval.summary)
            Text(reviewed.approval.risk.displayLabel)
            MobileJSONView(text: reviewed.approval.input.prettyJSONString)
          }
          if reviewed.decision == .deny {
            TextField("Optional note for the agent", text: $denyNote, axis: .vertical).lineLimit(
              3...6)
          } else {
            Text(
              reviewed.scope == .always
                ? "Allow matching actions in future tasks without asking again. Hard safety limits still apply."
                : "Allow matching actions for this task without asking again.")
          }
          Button(
            reviewed.decision == .deny ? "Deny action" : "Confirm approval",
            role: reviewed.decision == .deny ? .destructive : nil
          ) {
            review = nil
            send(
              reviewed.approval, decision: reviewed.decision, scope: reviewed.scope,
              runner: reviewed.runner)
          }
          .disabled(unavailable != nil || isSending)
        }
        .navigationTitle(reviewed.decision == .deny ? "Deny action" : "Approval scope")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { review = nil } }
        }
      }
    }

    private func send(
      _ reviewed: ApprovalRequest, decision: ApprovalDecision, scope: ApprovalScope,
      runner: AgentRunsOn?
    ) {
      Task {
        await store.decideReviewedApproval(
          reviewed, decision: decision, scope: scope, note: decision == .deny ? denyNote : nil,
          reviewedRunner: runner, authorizationAvailable: actionsEnabled)
      }
    }
  }
#endif
