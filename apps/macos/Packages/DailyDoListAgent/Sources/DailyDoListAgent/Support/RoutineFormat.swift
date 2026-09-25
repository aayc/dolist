import DailyDoListModels
import Foundation

/// Words for routines in the Routines view (web: the same phrases).
public enum RoutineFormat {
  /// The schedule in words, or the phrase as written when the daemon couldn't read it.
  public static func schedule(_ routine: Routine) -> String {
    routine.scheduleText ?? (routine.schedule.isEmpty ? "No schedule" : "“\(routine.schedule)”")
  }

  /// "Next run today at 7:30 AM", "Paused", "Can't run", "Not scheduled".
  public static func nextRun(
    _ routine: Routine, now: Date = Date(), calendar: Calendar = .current,
    locale: Locale = .current
  ) -> String {
    if routine.error != nil { return "Can't run" }
    if routine.paused { return "Paused" }
    guard let next = routine.nextRunAt else { return "Not scheduled" }
    return "Next run \(when(Date(epochMillis: next), now: now, calendar: calendar, locale: locale))"
  }

  /// The line beside a routine's state chip: the next run while it's scheduled, the last result
  /// while it's paused (the chip already says so), nothing when it has a problem (shown below).
  public static func subtitle(
    _ routine: Routine, now: Date = Date(), calendar: Calendar = .current,
    locale: Locale = .current
  ) -> String? {
    if routine.error != nil { return nil }
    if routine.paused {
      guard let summary = routine.lastRun?.summary, !summary.isEmpty else { return nil }
      return "Last result: \(summary)"
    }
    return nextRun(routine, now: now, calendar: calendar, locale: locale)
  }

  /// "today at 7:30 AM", "tomorrow at 7:30 AM", "on Monday at 9:00 AM" (within a week), "on
  /// Sep 30 at 9:00 AM".
  public static func when(
    _ date: Date, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current
  ) -> String {
    let time = date.formatted(
      Date.FormatStyle(
        date: .omitted, time: .shortened, locale: locale, calendar: calendar,
        timeZone: calendar.timeZone))
    let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
    let days =
      calendar.dateComponents(
        [.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)
      ).day ?? 0
    switch days {
    case 0: return "today at \(time)"
    case 1: return "tomorrow at \(time)"
    case -1: return "yesterday at \(time)"
    case 2..<7: return "on \(date.formatted(style.weekday(.wide))) at \(time)"
    default: return "on \(date.formatted(style.month(.abbreviated).day())) at \(time)"
    }
  }

  /// How a run is titled in its routine's inbox: "Today, 7:30 AM", "Yesterday, 7:30 AM",
  /// "Mon, Sep 21, 7:30 AM".
  public static func runTitle(
    _ startedAt: EpochMillis, now: Date = Date(), calendar: Calendar = .current,
    locale: Locale = .current
  ) -> String {
    let date = Date(epochMillis: startedAt)
    let time = date.formatted(
      Date.FormatStyle(
        date: .omitted, time: .shortened, locale: locale, calendar: calendar,
        timeZone: calendar.timeZone))
    if calendar.isDate(date, inSameDayAs: now) { return "Today, \(time)" }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
      calendar.isDate(date, inSameDayAs: yesterday)
    {
      return "Yesterday, \(time)"
    }
    let day = date.formatted(
      Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        .weekday(.abbreviated).month(.abbreviated).day())
    return "\(day), \(time)"
  }

  /// "Notifies after every run", "Notifies when something changed", "Never notifies".
  public static func notify(_ notify: RoutineNotify) -> String {
    switch notify {
    case .whenChanged: "Notifies when something changed"
    case .never: "Never notifies"
    default: "Notifies after every run"
    }
  }

  /// The choices of the New Routine sheet.
  static let notifyChoices: [(RoutineNotify, String)] = [
    (.always, "Every run"), (.whenChanged, "When something changed"), (.never, "Never"),
  ]

  /// "Uses the web and connectors".
  public static func uses(_ uses: [RoutineUse]) -> String? {
    guard !uses.isEmpty else { return nil }
    let names = uses.map { use -> String in
      switch use {
      case .web: "the web"
      case .browser: "the browser"
      case .computer: "your apps"
      case .shell: "the shell"
      case .files: "files"
      case .connectors: "connectors"
      default: use.rawValue
      }
    }
    let joined =
      names.count == 1
      ? names[0] : names.dropLast().joined(separator: ", ") + " and " + names[names.count - 1]
    return "Uses \(joined)"
  }

  /// The last run in a few words: "Done", "Needs approval", "Never run".
  public static func lastRunStatus(_ routine: Routine) -> String {
    guard let run = routine.lastRun else { return "Never run" }
    if run.status == .done, run.changed == false { return "Nothing new" }
    return run.status.displayLabel
  }
}
