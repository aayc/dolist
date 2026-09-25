import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Pinned at the top of the inbox: the orchestrator's own chat, with its live status and latest
/// message.
struct OrchestratorInboxRow: View {
  let summary: ThreadSummary?
  let pendingApprovals: Int
  let now: Date
  let action: () -> Void

  var body: some View {
    let status = summary?.status ?? .idle
    Button(action: action) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "point.3.connected.trianglepath.dotted")
          .foregroundStyle(AgentTheme.accent)
          .symbolEffect(.pulse, isActive: status == .working)
          .frame(width: 16)
          .padding(.top, 1)
        VStack(alignment: .leading, spacing: 3) {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: OrchestratorThread.title)
              .font(.system(size: 13, weight: .semibold))
            Spacer(minLength: 4)
            if let summary, summary.messageCount > 0 {
              Text(
                verbatim: AgentFormat.relativeTime(Date(epochMillis: summary.updatedAt), now: now)
              )
              .font(.caption)
              .monospacedDigit()
              .foregroundStyle(AgentTheme.mutedText)
            }
          }
          Text(verbatim: preview)
            .font(.callout)
            .foregroundStyle(AgentTheme.mutedText)
            .lineLimit(2)
          HStack(spacing: 6) {
            StatusChip(status: status)
            Spacer(minLength: 0)
            if pendingApprovals > 0 {
              CountBadge(
                count: pendingApprovals, tone: .warning, systemImage: "exclamationmark.shield.fill"
              )
              .tooltip(
                pendingApprovals == 1
                  ? "1 approval waiting" : "\(pendingApprovals) approvals waiting")
            }
          }
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .contentShape(Rectangle())
    }
    .buttonStyle(RowButtonStyle())
    .background(RoundedRectangle(cornerRadius: 8).fill(AgentTheme.subtleFill))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AgentTheme.border))
    .tooltip("Open the orchestrator's chat")
    .accessibilityElement(children: .combine)
    .accessibilityHint("Opens the orchestrator's chat")
  }

  private var preview: String {
    let text = summary?.lastMessagePreview.map(AgentFormat.plainPreview) ?? ""
    return text.isEmpty ? "Sees every task. Ask what it's doing, or tell it what to change." : text
  }
}
