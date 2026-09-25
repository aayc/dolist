import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// What importing would do (`POST /api/import/obsidian/preview`): counts first, then groups a
/// glance can skip, long lists folded.
struct ImportReportView: View {
  let preview: ObsidianImportPreview

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      stats
      if preview.attachments.count > 0 {
        Text("Attachments: \(ImportText.attachments(preview.attachments)).")
          .font(.callout).foregroundStyle(.secondary)
      }
      ImportWarnings(warnings: preview.warnings)
      ReportGroup("Settings from Obsidian") { settings }
      ReportGroup("Community plugins") { plugins }
      if preview.canvases.count > 0 || preview.drawings.count > 0 {
        ReportGroup("Canvases and drawings") { canvases }
      }
      CarryOverView(plan: preview.carryOver)
      if preview.skipped.count > 0 {
        ReportGroup("Not copied") { SkippedList(list: preview.skipped) }
      }
    }
  }

  private var stats: some View {
    Grid(horizontalSpacing: 8, verticalSpacing: 8) {
      GridRow {
        ReportStat(label: "Notes", value: "\(preview.notes)")
        ReportStat(label: "Folders", value: "\(preview.folders)")
        ReportStat(
          label: "Attachments", value: "\(preview.attachments.count)",
          detail: preview.attachments.count > 0 ? ImportText.bytes(preview.attachments.bytes) : nil
        )
      }
      GridRow {
        ReportStat(label: "Canvases", value: "\(preview.canvases.count)")
        ReportStat(label: "Drawings", value: "\(preview.drawings.count)")
        ReportStat(
          label: "In all", value: ImportText.count(preview.files, "file"),
          detail: ImportText.bytes(preview.bytes))
      }
    }
  }

  @ViewBuilder private var settings: some View {
    let found = preview.settings
    let editor = ImportText.editor(found.editor, vimrc: found.vimrc)
    ReportFact(
      "Daily notes",
      found.dailyNotes.map(ImportText.dailyNotes) ?? "none: yours keep this vault's settings")
    if !editor.isEmpty { ReportFact("Editor", ImportText.join(editor)) }
    if let theme = found.theme { ReportFact("Theme", theme.rawValue) }
    ReportFact(
      "Templates",
      preview.templates.folder.map {
        "\(ImportText.count(preview.templates.count, "template")) in \($0)"
      } ?? "no templates folder")
  }

  @ViewBuilder private var plugins: some View {
    if preview.plugins.isEmpty {
      Text("No community plugins are turned on.").foregroundStyle(.secondary)
    } else {
      Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 6) {
        ForEach(preview.plugins, id: \.id) { plugin in
          GridRow(alignment: .firstTextBaseline) {
            Text(plugin.name ?? plugin.id).fontWeight(.medium)
            SupportChip(support: plugin.support)
            Text(plugin.note).foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      Text(
        "Every plugin's files are copied, so they still work if you open the new vault in Obsidian."
      )
      .font(.callout).foregroundStyle(.secondary)
    }
  }

  @ViewBuilder private var canvases: some View {
    if preview.canvases.count > 0 {
      Text(
        "\(ImportText.count(preview.canvases.count, "canvas", "canvases")): copied, but they don't open here yet (they still open in Obsidian)."
      )
      PathFold(title: "Show the canvases", list: preview.canvases)
    }
    if preview.drawings.count > 0 {
      Text(
        "\(ImportText.count(preview.drawings.count, "Excalidraw drawing")): they open and edit here."
      )
      PathFold(title: "Show the drawings", list: preview.drawings)
    }
  }
}

/// What happens to the current vault's notes, routines and agent history.
struct CarryOverView: View {
  let plan: CarryOverPlan

  var body: some View {
    ReportGroup("Your Daily Do List notes") {
      Text(
        SettingsCallout.inlineMarkdown(
          "Your current vault, `\(plan.vault)`, stays exactly as it is: it's your backup. Its notes are copied into the new vault."
        )
      )
      .fixedSize(horizontal: false, vertical: true)
      ReportFact("Daily notes", dailyText)
      ReportFact("Other files", otherText)
      if plan.collisions.count > 0 {
        ReportFact(
          "Same names",
          "\(ImportText.count(plan.collisions.count, "file")) \(plan.collisions.count == 1 ? "has" : "have") the name of an Obsidian file, so “(Daily Do List)” is added."
        )
      }
      ReportFact("Agent history", historyText)
      if plan.watchedOpenTasks > 0 {
        Text(ImportText.watchedTasks(plan))
          .padding(8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
          .fixedSize(horizontal: false, vertical: true)
      }
      if plan.daily.count > 0 {
        DisclosureGroup("Show the daily notes") {
          VStack(alignment: .leading, spacing: 2) {
            ForEach(plan.daily.items, id: \.from) { note in
              HStack(spacing: 4) {
                Text("\(note.from) → \(note.to)").font(.system(.caption, design: .monospaced))
                if note.merged {
                  Text("added to Obsidian's").font(.caption).foregroundStyle(.secondary)
                }
              }
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .pointingHandCursor()
      }
      MoveFold(title: "Show the other files", list: plan.notes)
    }
  }

  private var dailyText: String {
    guard plan.daily.count > 0 else { return "none to carry over." }
    let from =
      switch plan.dailyNotesFrom {
      case .obsidian: "as Obsidian keeps them"
      case .obsidianDefaults: "Obsidian's default place"
      default: "as this vault keeps them"
      }
    var text =
      "\(ImportText.count(plan.daily.count, "note")) move to \(ImportText.dailyPlace(plan.dailyNotes)), \(from)."
    if plan.daily.merged > 0 {
      text +=
        " \(ImportText.count(plan.daily.merged, "date is", "dates are")) in both vaults: Obsidian's note is kept, and yours is added at its end under “From Daily Do List”."
    }
    return text
  }

  private var otherText: String {
    let others = plan.notes.count - plan.collisions.count
    return others > 0 ? "\(ImportText.count(others, "file")) keep their paths." : "none."
  }

  private var historyText: String {
    let agent = plan.agent
    let parts = [
      agent.threads > 0 ? ImportText.count(agent.threads, "thread") : nil,
      agent.records > 0 ? ImportText.count(agent.records, "task record") : nil,
      agent.approvals > 0 ? ImportText.count(agent.approvals, "approval") : nil,
      agent.routines > 0 ? "the schedules of \(ImportText.count(agent.routines, "routine"))" : nil,
    ].compactMap { $0 }
    var text = parts.isEmpty ? "nothing to carry over." : "\(ImportText.join(parts)) come along."
    if agent.detached > 0 {
      text +=
        " \(ImportText.count(agent.detached, "thread")) whose task isn't in its note any more \(agent.detached == 1 ? "is" : "are") kept, marked detached."
    }
    return text
  }
}

/// What "Update from Obsidian" did.
struct UpdateReportView: View {
  let report: ObsidianUpdateReport

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(ImportText.update(report)).fixedSize(horizontal: false, vertical: true)
      PathFold(title: "New in Obsidian: \(report.added.count)", list: report.added)
      PathFold(title: "Changed in Obsidian: \(report.updated.count)", list: report.updated)
      PathFold(
        title: "Deleted here, changed in Obsidian, brought back: \(report.restored.count)",
        list: report.restored)
      MoveFold(
        title: "Changed in both places, Obsidian's version saved next to yours: "
          + "\(report.conflicts.count)", list: report.conflicts)
      PathFold(
        title: "Deleted in Obsidian, kept here: \(report.deletedInSource.count)",
        list: report.deletedInSource)
      if report.skipped.count > 0 { SkippedList(list: report.skipped) }
    }
    .font(.callout)
  }
}

struct ImportWarnings: View {
  let warnings: [String]

  var body: some View {
    if !warnings.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        ForEach(warnings, id: \.self) { warning in
          Label {
            Text(warning).fixedSize(horizontal: false, vertical: true)
          } icon: {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning)
          }
        }
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Theme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
    }
  }
}

private struct ReportGroup<Content: View>: View {
  let title: String
  @ViewBuilder let content: Content

  init(_ title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Divider()
      Text(title.uppercased())
        .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      content
    }
  }
}

private struct ReportStat: View {
  let label: String
  let value: String
  var detail: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label).font(.caption).foregroundStyle(.secondary)
      HStack(alignment: .firstTextBaseline, spacing: 5) {
        Text(value).font(.title3.weight(.semibold)).monospacedDigit()
        if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 6))
  }
}

private struct ReportFact: View {
  let name: String
  let value: String

  init(_ name: String, _ value: String) {
    self.name = name
    self.value = value
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(name).foregroundStyle(.secondary).frame(width: 104, alignment: .leading)
      Text(value).fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct SupportChip: View {
  let support: ObsidianPluginSupport

  var body: some View {
    Text(ImportText.support(support))
      .font(.caption.weight(.medium))
      .padding(.horizontal, 6)
      .padding(.vertical, 1)
      .foregroundStyle(color)
      .background(color.opacity(0.14), in: Capsule())
  }

  private var color: Color {
    switch support {
    case .supported: Theme.success
    case .partial: Theme.warning
    default: .secondary
    }
  }
}

private struct PathFold: View {
  let title: String
  let list: ImportPathList

  var body: some View {
    if list.count > 0 {
      DisclosureGroup(title) {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(list.paths, id: \.self) { Text($0).font(.system(.caption, design: .monospaced)) }
          if list.count > list.paths.count {
            Text("and \(list.count - list.paths.count) more").font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .pointingHandCursor()
    }
  }
}

private struct MoveFold: View {
  let title: String
  let list: ImportMoveList

  var body: some View {
    if list.count > 0 {
      DisclosureGroup(title) {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(list.items, id: \.from) { move in
            Text(move.from == move.to ? move.from : "\(move.from) → \(move.to)")
              .font(.system(.caption, design: .monospaced))
          }
          if list.count > list.items.count {
            Text("and \(list.count - list.items.count) more").font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .pointingHandCursor()
    }
  }
}

private struct SkippedList: View {
  let list: ImportSkippedList

  var body: some View {
    DisclosureGroup(
      "\(ImportText.count(list.count, "file")) \(list.count == 1 ? "isn't" : "aren't") copied"
    ) {
      VStack(alignment: .leading, spacing: 2) {
        ForEach(list.items, id: \.path) { item in
          Text("\(item.path) — \(ImportText.skipReason(item.reason))").font(.caption)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .pointingHandCursor()
  }
}
