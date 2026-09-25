import Foundation

/// An app `resolveApp` can name: running, installed, or both (the same bundle id).
struct AppCandidate: Equatable, Sendable {
  var running: RunningApp?
  var installed: InstalledApp?

  var name: String { running?.name ?? installed?.name ?? "?" }
  var bundleId: String? { running?.bundleId ?? installed?.bundleId }

  /// Every name it answers to: localized, bundle and file names, running and installed.
  var names: [String] {
    var names = running?.names ?? []
    for name in installed?.names ?? [] where !names.contains(name) { names.append(name) }
    return names
  }

  var identity: ProcessIdentity {
    ProcessIdentity(pid: running?.pid, bundleId: bundleId, names: names)
  }
}

enum AppResolution: Equatable {
  case match(AppCandidate)
  case ambiguous([AppCandidate])
  case none
}

/// Name matching for `resolveApp`: a case- and accent-insensitive exact match on any of an app's
/// names, else a unique prefix match, else a unique contains match. Several matches at the first
/// stage that has any are ambiguous.
enum AppResolver {
  /// Running apps with UI and installed apps, merged by bundle id.
  static func candidates(running: [RunningApp], installed: [InstalledApp]) -> [AppCandidate] {
    var candidates: [AppCandidate] = []
    var indexByBundle: [String: Int] = [:]
    for app in running where app.kind != .background {
      if let bundle = app.bundleId?.lowercased() {
        if indexByBundle[bundle] != nil { continue }
        indexByBundle[bundle] = candidates.count
      }
      candidates.append(AppCandidate(running: app))
    }
    for app in installed {
      let bundle = app.bundleId.lowercased()
      if let index = indexByBundle[bundle] {
        candidates[index].installed = candidates[index].installed ?? app
      } else {
        indexByBundle[bundle] = candidates.count
        candidates.append(AppCandidate(installed: app))
      }
    }
    return candidates
  }

  static func resolve(_ query: String, among candidates: [AppCandidate]) -> AppResolution {
    let wanted = normalize(query)
    guard !wanted.isEmpty else { return .none }
    let stages: [(String) -> Bool] = [
      { $0 == wanted }, { $0.hasPrefix(wanted) }, { $0.contains(wanted) },
    ]
    for stage in stages {
      let matches = candidates.filter { $0.names.map(normalize).contains(where: stage) }
      if matches.count == 1 { return .match(matches[0]) }
      if matches.count > 1 {
        return .ambiguous(
          matches.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending })
      }
    }
    return .none
  }

  static func normalize(_ name: String) -> String {
    var folded = name.folding(
      options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil
    )
    .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    if folded.hasSuffix(".app") { folded = String(folded.dropLast(4)) }
    return folded.trimmingCharacters(in: .whitespaces)
  }

  static func ambiguityMessage(query: String, candidates: [AppCandidate]) -> String {
    let limit = 10
    var listed = candidates.prefix(limit).map { candidate in
      "\"\(candidate.name)\"" + (candidate.bundleId.map { " (\($0))" } ?? "")
    }
    if candidates.count > limit { listed.append("and \(candidates.count - limit) more") }
    return "Several apps match \"\(query.prefix(100))\": \(listed.joined(separator: ", ")). "
      + "Use a more specific name, or the bundleId."
  }
}
