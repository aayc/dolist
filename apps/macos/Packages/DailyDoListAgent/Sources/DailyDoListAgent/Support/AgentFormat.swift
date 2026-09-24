import DailyDoListModels
import Foundation

/// Display formatting shared by the agent views (web: lib/format.ts, ToolCallRow).
public enum AgentFormat {
  // MARK: Durations

  /// "420 ms", "3.2 s", "38m 16s", "2h 5m". Long durations are usually time spent waiting for
  /// the user's approval.
  public static func duration(milliseconds: Double) -> String {
    // Timestamps come from the wire: keep absurd values from overflowing `Int`.
    let ms = min(max(0, milliseconds.isFinite ? milliseconds : 0), 1e13)
    if ms < 1000 { return "\(Int(ms.rounded(.down))) ms" }
    if ms < 59_950 { return String(format: "%.1f s", ms / 1000) }
    let totalSeconds = Int((ms / 1000).rounded())
    let minutes = totalSeconds / 60
    if minutes < 60 { return "\(minutes)m \(totalSeconds % 60)s" }
    return "\(minutes / 60)h \(minutes % 60)m"
  }

  /// How long a finished tool call took (nil while it runs).
  public static func duration(of call: ToolCallMessage) -> String? {
    guard let endedAt = call.endedAt else { return nil }
    return duration(milliseconds: endedAt - call.createdAt)
  }

  // MARK: Dates

  /// "9:43 PM" today, "Sep 22, 9:43 PM" otherwise.
  public static func timestamp(
    _ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current
  ) -> String {
    let time = date.formatted(timeStyle(calendar: calendar, locale: locale))
    if calendar.isDate(date, inSameDayAs: now) { return time }
    return "\(monthDay(date, calendar: calendar, locale: locale)), \(time)"
  }

  public static func timestamp(
    _ millis: EpochMillis, now: Date = Date(), calendar: Calendar = .current,
    locale: Locale = .current
  ) -> String {
    timestamp(Date(epochMillis: millis), now: now, calendar: calendar, locale: locale)
  }

  /// Compact relative time for lists: "now", "5m", "3h" (today), "Yesterday", "Sep 22".
  public static func relativeTime(
    _ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current
  ) -> String {
    let seconds = now.timeIntervalSince(date)
    if seconds < 60 { return "now" }
    if seconds < 3600 { return "\(Int(seconds / 60))m" }
    if calendar.isDate(date, inSameDayAs: now) { return "\(Int(seconds / 3600))h" }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
      calendar.isDate(date, inSameDayAs: yesterday)
    {
      return "Yesterday"
    }
    return monthDay(date, calendar: calendar, locale: locale)
  }

  private static func timeStyle(calendar: Calendar, locale: Locale) -> Date.FormatStyle {
    Date.FormatStyle(
      date: .omitted, time: .shortened, locale: locale, calendar: calendar,
      timeZone: calendar.timeZone)
  }

  private static func monthDay(_ date: Date, calendar: Calendar, locale: Locale) -> String {
    date.formatted(
      Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        .month(.abbreviated).day())
  }

  // MARK: Approvals

  /// Decided state of an approval: "Approved once · 9:43 PM", "Denied · 9:43 PM"… (nil while
  /// pending).
  public static func decision(
    of approval: ApprovalRequest, now: Date = Date(), calendar: Calendar = .current,
    locale: Locale = .current
  ) -> String? {
    let label: String
    switch approval.status {
    case .pending: return nil
    case .approved:
      switch approval.scope ?? .once {
      case .once: label = "Approved once"
      case .task: label = "Approved for this task"
      case .always: label = "Always approved"
      }
    case .denied: label = "Denied"
    case .expired: label = "Expired (auto-denied)"
    case .cancelled: label = "Cancelled"
    default: label = humanize(approval.status.rawValue)
    }
    guard let decidedAt = approval.decidedAt else { return label }
    return "\(label) · \(timestamp(decidedAt, now: now, calendar: calendar, locale: locale))"
  }

  /// "Auto-denies at 9:05 AM" (or "Auto-denies Sep 24, 9:05 AM" when not today).
  public static func expiry(
    _ expiresAt: EpochMillis, now: Date = Date(), calendar: Calendar = .current,
    locale: Locale = .current
  ) -> String {
    let date = Date(epochMillis: expiresAt)
    let when = timestamp(date, now: now, calendar: calendar, locale: locale)
    return calendar.isDate(date, inSameDayAs: now)
      ? "Auto-denies at \(when)" : "Auto-denies \(when)"
  }

  /// Why a decision was refused (409): the approval's actual state.
  public static func conflictMessage(for approval: ApprovalRequest) -> String {
    switch approval.status {
    case .approved: "This approval was already approved."
    case .denied: "This approval was already denied."
    case .expired: "This approval expired before your decision arrived."
    case .cancelled: "This approval was cancelled."
    default: "This approval is no longer pending."
    }
  }

  // MARK: Messages

  /// "Orchestrator", "Research agent" (`subagent:research`), "You", "System".
  public static func authorLabel(_ author: MessageAuthor) -> String {
    switch author {
    case "orchestrator": return "Orchestrator"
    case "you": return "You"
    case "system": return "System"
    default:
      guard let name = author.subagentName else { return author }
      let words = name.replacingOccurrences(of: "_", with: " ").replacingOccurrences(
        of: "-", with: " ")
      guard let first = words.first else { return "Agent" }
      return "\(first.uppercased())\(words.dropFirst()) agent"
    }
  }

  /// A one-paragraph plain preview of markdown (inbox rows, notifications).
  public static func plainPreview(_ markdown: String) -> String {
    let stripped = markdown.unicodeScalars.filter { !"*_`#>".unicodeScalars.contains($0) }
    return String(String.UnicodeScalarView(stripped))
      .split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  // MARK: Misc

  /// "12 B", "3.4 KB", "1.2 MB"
  public static func bytes(_ count: Int) -> String {
    if count < 1024 { return "\(count) B" }
    if count < 1024 * 1024 { return String(format: "%.1f KB", Double(count) / 1024) }
    return String(format: "%.1f MB", Double(count) / (1024 * 1024))
  }

  /// The note's name without folders and extension ("Daily/2026-09-23.md" → "2026-09-23").
  public static func noteName(_ path: String) -> String {
    let base = path.split(separator: "/").last.map(String.init) ?? path
    guard let dot = base.lastIndex(of: "."), dot != base.startIndex else { return base }
    return String(base[..<dot])
  }
}
