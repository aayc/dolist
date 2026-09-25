import Foundation

extension ComputerService {
  static let defaultMaxNodes = 400
  static let defaultMaxDepth = 30

  /// `snapshot` `{pid, elementId?, snapshotId?, maxNodes?, maxDepth?}`: reads the app's window
  /// (focused, else main, else first; the app itself when it has none) into a new snapshot, or,
  /// with `elementId` and `snapshotId`, expands that element's subtree into the same snapshot.
  func snapshot(_ params: Params) async throws -> JSONValue {
    let pid = try params.pid()
    let maxNodes = try params.integer("maxNodes", in: 1...2_000) ?? Self.defaultMaxNodes
    let maxDepth = try params.integer("maxDepth", in: 0...100) ?? Self.defaultMaxDepth
    let elementId = try params.elementID()
    let snapshotId = try params.snapshotID()
    guard (elementId == nil) == (snapshotId == nil) else {
      throw ComputerError.invalid(
        "snapshot: pass elementId and snapshotId together, to expand an element of that snapshot.")
    }
    let app = try await targetApp(pid)
    try requireAccessibility()
    let limits = WalkLimits(
      maxNodes: maxNodes, maxDepth: maxDepth,
      deadline: system.clock.now + configuration.snapshotTimeBudget)
    if let elementId, let snapshotId {
      return try expand(elementId, of: snapshotId, app: app, limits: limits)
    }

    await enableElectronAccessibility(app)
    let window = try scopeWindow(of: app)
    if let window { try refuseIfShowingDailyDoList(window: window, of: app) }
    let root = window ?? system.accessibility.applicationElement(pid: pid)
    let result = try walk(from: root, of: app, limits: limits)
    let rootInfo = result.nodes[0].info
    var snapshot = snapshots.makeSnapshot(
      app: app.summary,
      window: window.map { _ in WindowSummary(title: rootInfo.title ?? "", frame: rootInfo.frame) },
      root: root)
    let ids = snapshot.adopt(result)
    snapshots.save(snapshot)
    return response(for: snapshot, result, ids: ids)
  }

  private func expand(
    _ elementId: String, of snapshotId: String, app: RunningApp, limits: WalkLimits
  ) throws -> JSONValue {
    var snapshot = try snapshots.snapshot(pid: app.pid, id: snapshotId)
    guard let entry = snapshot.entries[elementId] else {
      throw ComputerError.notFound("There's no element \(elementId) in snapshot \(snapshotId).")
    }
    if snapshot.window != nil { try refuseIfShowingDailyDoList(window: snapshot.root, of: app) }
    let result: WalkResult
    do {
      result = try walk(from: entry.element, of: app, limits: limits)
    } catch let error as ComputerError where error.code == .stale {
      snapshots.invalidate(pid: app.pid)
      throw ComputerError.stale("\(elementId) is gone: read the app again.")
    }
    let ids = snapshot.adopt(result)
    snapshots.save(snapshot)
    return response(for: snapshot, result, ids: ids)
  }

  /// Walks a subtree, refusing any web area that shows Daily Do List.
  private func walk(from root: AccessibilityElement, of app: RunningApp, limits: WalkLimits) throws
    -> WalkResult
  {
    let targets = configuration.protectedTargets
    let appName = app.name
    let walker = TreeWalker(api: system.accessibility, clock: system.clock) { info in
      if info.role == AX.webArea, let url = info.url, targets.isWebUI(url: url) {
        throw ProtectedTargets.error(for: .webUI, appName: appName)
      }
    }
    do {
      return try walker.walk(from: root, limits: limits)
    } catch let error as AccessibilityError {
      throw error.asAppError(appName: app.name)
    }
  }

  private func response(for snapshot: Snapshot, _ result: WalkResult, ids: [Int: String])
    -> JSONValue
  {
    let elements = result.preorder.map { index in
      TreeFormatter.elementJSON(id: ids[index] ?? "?", info: result.nodes[index].info)
    }
    return [
      "snapshotId": .string(snapshot.id),
      "app": snapshot.app.json,
      "window": snapshot.window?.json ?? .null,
      "text": .string(TreeFormatter.render(result, ids: ids)),
      "elements": .array(elements),
      "truncated": .bool(result.truncated),
    ]
  }
}
