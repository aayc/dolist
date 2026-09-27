import DailyDoListWorkspaceCore
import Foundation

/// Disposable view state never participates in note or agent mutations.
public struct WorkspaceNavigation: Codable, Sendable {
  public struct Position: Codable, Sendable {
    public var selection: NSRange
    public var scrollY: Double
    public init(selection: NSRange, scrollY: Double) {
      self.selection = selection
      self.scrollY = scrollY
    }
  }
  public var tabs: TabsStore.Snapshot
  public var positions: [String: Position]
  public var section: Int
  public init(tabs: TabsStore.Snapshot, positions: [String: Position], section: Int) {
    self.tabs = tabs
    self.positions = positions
    self.section = section
  }
}

extension WorkspaceCache {
  public func navigation() throws -> CachedWorkspaceValue<WorkspaceNavigation>? {
    guard let stored = try store.value("cache/navigation") else { return nil }
    let value: WorkspaceNavigation
    do { value = try JSONDecoder().decode(WorkspaceNavigation.self, from: stored.data) } catch {
      throw WorkspaceRepositoryError.corruptIndex
    }
    return CachedWorkspaceValue(
      value: value, revision: stored.revision, updatedAt: stored.updatedAt)
  }

  /// Called by one window's serialized checkpoints, not by the input view on each keystroke.
  @discardableResult
  public func storeNavigation(_ value: WorkspaceNavigation, replacing revision: Int64?) throws
    -> Int64
  {
    let record = WorkspaceStoredValue(
      key: "cache/navigation", data: try JSONEncoder().encode(value), updatedAt: clock(),
      retention: .disposable)
    let revisions = try store.commitValues([
      WorkspaceValueMutation(key: record.key, value: record, expectedRevision: revision)
    ])
    guard let next = revisions[record.key] else { throw WorkspaceRepositoryError.corruptIndex }
    _ = try trim()
    return next
  }
}
