import Foundation

/// An app as responses name it: `{"name", "bundleId", "pid"}`.
struct AppSummary: Equatable, Sendable {
  var name: String
  var bundleId: String?
  var pid: Int32

  var json: JSONValue {
    ["name": .string(name), "bundleId": .string(bundleId), "pid": .number(Double(pid))]
  }
}

/// A window as responses name it: `{"title", "frame"}`.
struct WindowSummary: Equatable, Sendable {
  var title: String
  var frame: Rect?

  var json: JSONValue { ["title": .string(title), "frame": frame?.json ?? .null] }
}

struct SnapshotEntry: Sendable {
  let element: AccessibilityElement
  var info: ElementInfo
}

/// One read of an app: its elements by id. Expanding an element adds its subtree to the same
/// snapshot: elements already in it keep their ids, new ones get the next free ids.
struct Snapshot: Sendable {
  let id: String
  let app: AppSummary
  let window: WindowSummary?
  /// The element the snapshot starts at (the window, or the app when it has no window).
  let root: AccessibilityElement
  private(set) var entries: [String: SnapshotEntry] = [:]
  private var ids: [AccessibilityElement: String] = [:]
  private var nextNumber = 1

  init(id: String, app: AppSummary, window: WindowSummary?, root: AccessibilityElement) {
    self.id = id
    self.app = app
    self.window = window
    self.root = root
  }

  /// Gives each node of `result` its id in this snapshot (existing, else the next free one, in
  /// document order) and records the nodes. Returns the ids by node index.
  mutating func adopt(_ result: WalkResult) -> [Int: String] {
    var assigned: [Int: String] = [:]
    for index in result.preorder {
      let node = result.nodes[index]
      let id: String
      if let existing = ids[node.element] {
        id = existing
      } else {
        id = "e\(nextNumber)"
        nextNumber += 1
        ids[node.element] = id
      }
      entries[id] = SnapshotEntry(element: node.element, info: node.info)
      assigned[index] = id
    }
    return assigned
  }
}

/// The latest snapshot of each app. Taking a new snapshot of an app, or acting on it, retires the
/// previous one: its id (and every element id in it) then answers `stale`.
struct SnapshotStore: Sendable {
  /// Apps whose latest snapshot is kept; the least recently used one is dropped beyond that.
  static let capacity = 16

  private var snapshots: [Int32: Snapshot] = [:]
  private var recent: [Int32] = []
  private var nextNumber = 1

  mutating func makeSnapshot(
    app: AppSummary, window: WindowSummary?, root: AccessibilityElement
  ) -> Snapshot {
    defer { nextNumber += 1 }
    return Snapshot(id: "s\(nextNumber)", app: app, window: window, root: root)
  }

  mutating func save(_ snapshot: Snapshot) {
    let pid = snapshot.app.pid
    snapshots[pid] = snapshot
    recent.removeAll { $0 == pid }
    recent.append(pid)
    while recent.count > Self.capacity {
      snapshots[recent.removeFirst()] = nil
    }
  }

  func current(pid: Int32) -> Snapshot? { snapshots[pid] }

  /// Retires `pid`'s snapshot; returns whether there was one.
  @discardableResult
  mutating func invalidate(pid: Int32) -> Bool {
    recent.removeAll { $0 == pid }
    return snapshots.removeValue(forKey: pid) != nil
  }

  /// `pid`'s snapshot `id`, or `stale` when that isn't its latest snapshot.
  func snapshot(pid: Int32, id: String) throws -> Snapshot {
    guard let snapshot = snapshots[pid], snapshot.id == id else {
      throw ComputerError.stale(
        "Snapshot \(id) is out of date: read the app again and use the new element ids.")
    }
    return snapshot
  }

  func entry(pid: Int32, snapshotId: String, elementId: String) throws -> SnapshotEntry {
    guard let entry = try snapshot(pid: pid, id: snapshotId).entries[elementId] else {
      throw ComputerError.notFound("There's no element \(elementId) in snapshot \(snapshotId).")
    }
    return entry
  }
}
