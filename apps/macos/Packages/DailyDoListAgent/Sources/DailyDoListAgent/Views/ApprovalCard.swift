import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// A risky action waiting for the user (or the record of their decision): summary, tool, risk and
/// categories, the evaluator's reason, the exact input, and Approve once / Approve for this task /
/// Deny… (with an optional note for the agent). One that arrives while the chat is open glows
/// twice to draw the eye (not with Reduce Motion).
public struct ApprovalCard: View {
  let approval: ApprovalRequest
  let isDeciding: Bool
  let announces: Bool
  let onAnnounced: () -> Void
  let onDecide: (ApprovalDecision, ApprovalScope?, String?) -> Void
  @State private var showsDetails = false
  @State private var denying = false
  @State private var denyNote = ""
  @State private var attention = 0
  @Environment(\.agentReferenceDate) private var referenceDate
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// - Parameters:
  ///   - announces: it just arrived: draw attention once it appears (then `onAnnounced`).
  ///   - onDecide: decision, scope (approvals), note (denials).
  public init(
    approval: ApprovalRequest, isDeciding: Bool = false,
    onDecide: @escaping (ApprovalDecision, ApprovalScope?, String?) -> Void
  ) {
    self.init(
      approval: approval, isDeciding: isDeciding, announces: false, onAnnounced: {},
      onDecide: onDecide)
  }

  init(
    approval: ApprovalRequest, isDeciding: Bool, announces: Bool, onAnnounced: @escaping () -> Void,
    onDecide: @escaping (ApprovalDecision, ApprovalScope?, String?) -> Void
  ) {
    self.approval = approval
    self.isDeciding = isDeciding
    self.announces = announces
    self.onAnnounced = onAnnounced
    self.onDecide = onDecide
  }

  /// An approval from the store, decided through it.
  public init(store: AgentStore, approval: ApprovalRequest) {
    self.init(
      approval: approval, isDeciding: store.decidingApprovalIds.contains(approval.id)
    ) { decision, scope, note in
      Task { await store.decide(approval.id, decision, scope: scope, note: note) }
    }
  }

  private var tint: Color {
    approval.isPending
      ? AgentTheme.warning : approval.status == .approved ? AgentTheme.success : AgentTheme.faint
  }

  public var body: some View {
    let now = referenceDate ?? Date()
    VStack(alignment: .leading, spacing: 10) {
      header
      Text(verbatim: approval.summary)
        .font(.system(size: 14, weight: .semibold))
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
      FlowLayout(spacing: 4) {
        Chip(text: approval.risk.displayLabel, tone: approval.risk.tone)
        ForEach(approval.categories, id: \.self) { category in
          Chip(text: category.displayLabel)
        }
      }
      if !approval.reason.isEmpty {
        Text(verbatim: approval.reason)
          .font(.callout)
          .foregroundStyle(AgentTheme.mutedText)
          .fixedSize(horizontal: false, vertical: true)
      }
      DisclosureGroup(isExpanded: $showsDetails) {
        JSONBlock(text: approval.input.prettyJSONString).padding(.top, 4)
      } label: {
        Text("Details").font(.caption)
      }
      .disclosureGroupStyle(ChevronDisclosureStyle())
      if approval.isPending {
        pendingActions(now: now)
      } else {
        decision(now: now)
      }
    }
    .padding(12)
    .background(
      RoundedRectangle(cornerRadius: 10).fill(tint.opacity(approval.isPending ? 0.09 : 0.06))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10).strokeBorder(tint.opacity(approval.isPending ? 0.6 : 0.35))
    )
    .phaseAnimator([0.0, 1.0, 0.3, 0.9, 0.0], trigger: attention) { card, glow in
      card
        .overlay(
          RoundedRectangle(cornerRadius: 10)
            .strokeBorder(AgentTheme.warning.opacity(glow * 0.9), lineWidth: 1 + glow)
            .allowsHitTesting(false)
        )
        .shadow(color: AgentTheme.warning.opacity(glow * 0.35), radius: 10 * glow)
    } animation: { _ in
      .easeInOut(duration: 0.26)
    }
    .onAppear {
      guard announces else { return }
      onAnnounced()
      if approval.isPending, !reduceMotion { attention += 1 }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(approval.isPending ? "Approval needed: \(approval.summary)" : "Approval")
  }

  private var header: some View {
    HStack(spacing: 6) {
      Image(systemName: approval.status.systemImage).foregroundStyle(tint)
      Text(approval.isPending ? "Approval needed" : "Approval")
        .font(.headline)
        .foregroundStyle(approval.isPending ? AgentTheme.warning : AgentTheme.text)
      Spacer(minLength: 8)
      Label {
        Text(verbatim: approval.toolLabel ?? approval.toolName).lineLimit(1)
      } icon: {
        Image(systemName: ToolIcon.systemName(for: approval.toolName))
      }
      .font(.caption)
      .foregroundStyle(AgentTheme.mutedText)
    }
  }

  private func pendingActions(now: Date) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 6) {
          approveOnce
          approveForTask
          Spacer(minLength: 0)
          deny
        }
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 6) {
            approveOnce
            approveForTask
          }
          deny
        }
      }
      .disabled(isDeciding)
      .popover(isPresented: $denying, arrowEdge: .bottom) {
        DenyPopover(
          note: $denyNote, onCancel: { denying = false },
          onDeny: {
            denying = false
            onDecide(.deny, nil, denyNote)
          })
      }
      if isDeciding {
        HStack(spacing: 6) {
          ProgressView().controlSize(.small)
          Text("Sending your decision…")
        }
        .font(.caption)
        .foregroundStyle(AgentTheme.mutedText)
      } else if let expiresAt = approval.expiresAt {
        Label(AgentFormat.expiry(expiresAt, now: now), systemImage: "clock")
          .font(.caption)
          .foregroundStyle(AgentTheme.mutedText)
      }
    }
  }

  private var approveOnce: some View {
    Button("Approve once") { onDecide(.approve, .once, nil) }
      .buttonStyle(.borderedProminent)
      .pointingHandCursor()
  }

  private var approveForTask: some View {
    Button("Approve for this task") { onDecide(.approve, .task, nil) }
      .buttonStyle(.bordered)
      .pointingHandCursor()
  }

  private var deny: some View {
    Button(role: .destructive) {
      denying = true
    } label: {
      Text("Deny…").foregroundStyle(AgentTheme.danger)
    }
    .buttonStyle(.bordered)
    .pointingHandCursor()
  }

  private func decision(now: Date) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Image(
        systemName: approval.status == .approved ? "checkmark.circle.fill" : "xmark.circle.fill"
      )
      .foregroundStyle(tint)
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: AgentFormat.decision(of: approval, now: now) ?? "")
          .font(.callout.weight(.medium))
        if let note = approval.decisionNote, !note.isEmpty {
          Text(verbatim: "“\(note)”")
            .font(.callout)
            .italic()
            .foregroundStyle(AgentTheme.mutedText)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      if isDeciding {
        Spacer(minLength: 4)
        ProgressView().controlSize(.small)
      }
    }
  }
}

private struct DenyPopover: View {
  @Binding var note: String
  let onCancel: () -> Void
  let onDeny: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Deny this action?").font(.headline)
      TextField(
        "Optional note for the agent (why not, or what to do instead)", text: $note, axis: .vertical
      )
      .lineLimit(2...5)
      .textFieldStyle(.roundedBorder)
      HStack {
        Spacer()
        Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
          .pointingHandCursor()
          .tooltip("Cancel", keys: .escapeKey, accessibility: .keysOnly)
        Button("Deny", role: .destructive, action: onDeny).keyboardShortcut(.defaultAction)
          .pointingHandCursor()
          .tooltip("Deny", keys: .returnKey, accessibility: .keysOnly)
      }
    }
    .padding(14)
    .frame(width: 320)
  }
}

/// Placeholder while an approval message's request hasn't arrived yet.
struct ApprovalPlaceholder: View {
  var body: some View {
    HStack(spacing: 8) {
      ProgressView().controlSize(.small)
      Text("Loading approval…").font(.callout).foregroundStyle(AgentTheme.mutedText)
    }
    .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
    .padding(.horizontal, 12)
    .background(RoundedRectangle(cornerRadius: 10).strokeBorder(AgentTheme.border))
  }
}
