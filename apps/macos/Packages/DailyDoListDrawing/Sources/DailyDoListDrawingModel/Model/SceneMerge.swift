import Foundation

/// Merges two versions of a drawing that both changed since the version they started from (a save
/// that found the file changed elsewhere), element by element like Excalidraw's
/// `reconcileElements`, so neither side's work is lost:
///
/// - an element both sides have: the one with the higher `version` (the same version: the lower
///   `versionNonce`, ours on a tie), so edits and deletions (tombstones) win over older states;
/// - an element only one side has: kept, unless the other side removed it without a tombstone
///   (as Excalidraw and the plugin save) and this side didn't change it since the base;
/// - order: by fractional `index` when every element has one, else theirs with ours after the
///   element they followed;
/// - the rest of the scene (`appState`, other fields) is theirs; `files` has both sides' images.
public enum SceneMerge {
  public static func merge(
    base: ExcalidrawScene?, local: ExcalidrawScene, remote: ExcalidrawScene
  ) -> ExcalidrawScene {
    let baseVersions = Dictionary(
      (base?.elements ?? []).map { ($0.id, $0.version) }, uniquingKeysWith: { first, _ in first })
    let localById = Dictionary(local.elements.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    let remoteById = Dictionary(
      remote.elements.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

    func keeps(_ element: ExcalidrawElement) -> Bool {
      guard let baseVersion = baseVersions[element.id] else { return true }
      return element.version != baseVersion
    }

    var merged: [ExcalidrawElement] = []
    var placed = Set<String>()
    for theirs in remote.elements where !placed.contains(theirs.id) {
      placed.insert(theirs.id)
      if let ours = localById[theirs.id] {
        merged.append(prefersLocal(ours, over: theirs) ? ours : theirs)
      } else if keeps(theirs) {
        merged.append(theirs)
      }
    }
    // Ours that they don't have, after the element they followed in our order.
    var previous: String?
    for ours in local.elements {
      defer { previous = ours.id }
      guard remoteById[ours.id] == nil, !placed.contains(ours.id) else { continue }
      placed.insert(ours.id)
      guard keeps(ours) else { continue }
      let position =
        previous.flatMap { id in merged.firstIndex { $0.id == id }.map { $0 + 1 } }
        ?? (merged.isEmpty ? 0 : merged.count)
      merged.insert(ours, at: previous == nil ? 0 : position)
    }
    if merged.allSatisfy({ $0.index != nil }) {
      merged = merged.enumerated().sorted { a, b in
        let (left, right) = (a.element.index ?? "", b.element.index ?? "")
        return left != right ? left < right : a.offset < b.offset
      }.map(\.element)
    }

    var scene = remote
    scene.elements = merged
    scene.files = mergedFiles(local: local.files, remote: remote.files)
    return scene
  }

  /// Excalidraw's `shouldDiscardRemoteElement`: ours unless theirs is newer.
  static func prefersLocal(_ local: ExcalidrawElement, over remote: ExcalidrawElement) -> Bool {
    local.version > remote.version
      || (local.version == remote.version && local.versionNonce <= remote.versionNonce)
  }

  private static func mergedFiles(local: JSONValue, remote: JSONValue) -> JSONValue {
    guard case .object(var files) = remote, case .object(let ours) = local else { return remote }
    for (id, file) in ours where !files.contains(id) { files[id] = file }
    return .object(files)
  }
}
