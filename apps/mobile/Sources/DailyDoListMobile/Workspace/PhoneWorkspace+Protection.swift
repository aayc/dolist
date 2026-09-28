import Foundation

extension PhoneWorkspace {
  /// Revokes authority at once and returns the work that can still use this workspace's stores.
  /// A protection change must await it: cancelled work keeps its SQLite handles until it ends.
  func stopForStorageChange() -> [Task<Void, Never>] {
    let running = [downloadTask, synchronization, savingNavigation].compactMap { $0 }
    navigationDebounce?.cancel()
    invalidateAuthority()
    return running
  }
}
