import DailyDoListClient
import DailyDoListDomain
import DailyDoListModels
import Foundation
import Observation

/// Hits of one note in the search panel.
struct SearchGroup: Identifiable, Equatable {
  let path: String
  let hits: [SearchHit]

  var id: String { path }
  var title: String { VaultPath.stem(path) }
  var folder: String { VaultPath.dirname(path) }
  var nameHits: [SearchHit] { hits.filter { $0.kind == .name } }
  var contentHits: [SearchHit] { hits.filter { $0.kind == .content } }

  /// "·" for a name hit, else the 1-based line number.
  static func lineLabel(for hit: SearchHit) -> String {
    hit.kind == .name ? "·" : "\(hit.line + 1)"
  }
}

/// Vault search (⌘⇧F): debounced queries against the daemon, results grouped by note (name hits
/// before content hits, like the daemon returns them). Stale answers are dropped.
@MainActor
@Observable
final class SearchModel {
  var query = "" {
    didSet { if query != oldValue { schedule() } }
  }
  private(set) var groups: [SearchGroup] = []
  private(set) var hitCount = 0
  private(set) var isLoading = false
  private(set) var error: String?

  @ObservationIgnored private let client: DaemonClient
  @ObservationIgnored private let scheduler: AppScheduler
  @ObservationIgnored private let delay: TimeInterval
  @ObservationIgnored private var pending: ScheduledAction?
  @ObservationIgnored private var generation = 0

  init(client: DaemonClient, scheduler: AppScheduler, delay: TimeInterval = 0.18) {
    self.client = client
    self.scheduler = scheduler
    self.delay = delay
  }

  var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

  private func schedule() {
    pending?.cancel()
    generation += 1
    let q = trimmedQuery
    guard !q.isEmpty else {
      groups = []
      hitCount = 0
      isLoading = false
      error = nil
      return
    }
    isLoading = true
    let mine = generation
    pending = scheduler.schedule(after: delay) { [weak self] in
      Task { await self?.run(q, generation: mine) }
    }
  }

  /// Runs the current query now (e.g. Return in the field).
  func runNow() async {
    pending?.cancel()
    generation += 1
    await run(trimmedQuery, generation: generation)
  }

  private func run(_ q: String, generation mine: Int) async {
    guard !q.isEmpty else { return }
    do {
      let response = try await client.search(q, limit: nil)
      guard mine == generation else { return }
      groups = Self.group(response.hits)
      hitCount = response.hits.count
      error = nil
    } catch {
      guard mine == generation else { return }
      self.error = ToastStore.message(for: error)
    }
    isLoading = false
  }

  /// Groups hits by note, keeping the daemon's order of first appearance.
  static func group(_ hits: [SearchHit]) -> [SearchGroup] {
    var order: [String] = []
    var byPath: [String: [SearchHit]] = [:]
    for hit in hits {
      if byPath[hit.path] == nil { order.append(hit.path) }
      byPath[hit.path, default: []].append(hit)
    }
    return order.map { path in
      let hits = byPath[path] ?? []
      return SearchGroup(path: path, hits: hits.filter { $0.kind == .name } + hits.filter { $0.kind == .content })
    }
  }
}
