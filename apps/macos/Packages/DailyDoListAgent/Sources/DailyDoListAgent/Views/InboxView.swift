import DailyDoListModels
import SwiftUI

/// Today's threads grouped by what they need: Needs you, Working, Done, Other.
struct InboxView: View {
  let store: AgentStore
  let onSelect: (String) -> Void
  @Environment(\.agentReferenceDate) private var referenceDate

  var body: some View {
    TimelineView(.periodic(from: .now, by: 60)) { context in
      let now = referenceDate ?? context.date
      let sections = store.inboxSections(now: now)
      if sections.isEmpty {
        ContentUnavailableView {
          Label("Nothing here yet today", systemImage: "tray")
        } description: {
          Text("Write a task in today's daily note and the agent will pick it up.")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
            ForEach(sections) { section in
              Section {
                // Keyed by the whole summary: a LazyVStack keeps showing a stale row when a
                // thread moves to another section under the same id.
                ForEach(section.threads, id: \.self) { thread in
                  InboxRow(
                    thread: thread, unread: store.unreadCount(forThread: thread.id),
                    pendingApprovals: pendingCount(for: thread), now: now
                  ) { onSelect(thread.id) }
                }
              } header: {
                InboxSectionHeader(group: section.group, count: section.threads.count)
              }
            }
          }
          .padding(.horizontal, 6)
          .padding(.bottom, 10)
        }
      }
    }
  }

  private func pendingCount(for thread: ThreadSummary) -> Int {
    max(thread.pendingApprovals, store.pendingApprovals(forThread: thread.id).count)
  }
}

private struct InboxSectionHeader: View {
  let group: InboxGroup
  let count: Int

  var body: some View {
    HStack(spacing: 6) {
      Text(group.title.uppercased())
        .font(.caption.weight(.semibold))
        .foregroundStyle(group == .needsYou ? AgentTheme.warning : AgentTheme.mutedText)
      Text(verbatim: "\(count)").font(.caption).foregroundStyle(AgentTheme.faint)
      Spacer()
    }
    .padding(.horizontal, 10)
    .padding(.top, 12)
    .padding(.bottom, 4)
    .frame(maxWidth: .infinity)
    .background(AgentTheme.panelBackground)
    .accessibilityAddTraits(.isHeader)
  }
}

struct InboxRow: View {
  let thread: ThreadSummary
  let unread: Int
  let pendingApprovals: Int
  let now: Date
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: thread.status.systemImage)
          .foregroundStyle(thread.status.tone.color)
          .frame(width: 16)
          .padding(.top, 1)
        VStack(alignment: .leading, spacing: 3) {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: thread.title)
              .font(.system(size: 13, weight: unread > 0 ? .semibold : .medium))
              .lineLimit(1)
              .truncationMode(.tail)
            Spacer(minLength: 4)
            Text(verbatim: AgentFormat.relativeTime(Date(epochMillis: thread.updatedAt), now: now))
              .font(.caption)
              .monospacedDigit()
              .foregroundStyle(AgentTheme.mutedText)
          }
          if let preview = thread.lastMessagePreview.map(AgentFormat.plainPreview), !preview.isEmpty
          {
            Text(verbatim: preview)
              .font(.callout)
              .foregroundStyle(AgentTheme.mutedText)
              .lineLimit(2)
          }
          HStack(spacing: 6) {
            StatusChip(status: thread.status)
            if let notePath = thread.notePath {
              Text(verbatim: AgentFormat.noteName(notePath))
                .font(.caption)
                .foregroundStyle(AgentTheme.faint)
                .lineLimit(1)
            }
            Spacer(minLength: 0)
            if pendingApprovals > 0 {
              CountBadge(
                count: pendingApprovals, tone: .warning, systemImage: "exclamationmark.shield.fill"
              )
              .help("\(pendingApprovals) waiting for your approval")
            }
            if unread > 0 {
              CountBadge(count: unread, tone: .accent).help("\(unread) unread")
            }
          }
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .contentShape(Rectangle())
    }
    .buttonStyle(RowButtonStyle())
    .accessibilityElement(children: .combine)
    .accessibilityHint("Opens the thread")
  }
}
