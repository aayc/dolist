import Foundation

/// Holds async work until opened (to observe optimistic state mid-request).
actor Gate {
  private var isOpen = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private(set) var arrivals = 0

  func wait() async {
    arrivals += 1
    if isOpen { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func open() {
    isOpen = true
    for waiter in waiters { waiter.resume() }
    waiters.removeAll()
  }
}

/// Waits until the gate has at least `count` arrivals.
func waitForArrivals(_ gate: Gate, _ count: Int = 1, timeout: Duration = .seconds(10)) async -> Bool
{
  let deadline = ContinuousClock.now + timeout
  while ContinuousClock.now < deadline {
    if await gate.arrivals >= count { return true }
    try? await Task.sleep(for: .milliseconds(5))
  }
  return await gate.arrivals >= count
}
