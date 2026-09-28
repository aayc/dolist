/// One network pass at a time on a repository. Replay and refresh wait for each other in arrival
/// order: skipping would report stale cached content as fresh or drop pending edits until some
/// unrelated trigger. Owned and used by one actor only.
final class RepositoryPasses {
  private var running = false
  private var waiting: [CheckedContinuation<Void, Never>] = []
  var queued: Int { waiting.count }

  func begin(isolation: isolated (any Actor)? = #isolation) async {
    guard running else {
      running = true
      return
    }
    await withCheckedContinuation { waiting.append($0) }
  }

  /// Hands the pass to the next waiter, so a newcomer can't overtake it.
  func end() {
    if waiting.isEmpty { running = false } else { waiting.removeFirst().resume() }
  }
}
