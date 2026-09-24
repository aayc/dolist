import DailyDoListModels
import Foundation

/// A file or folder in the vault explorer. `id` is the vault path, stable across rebuilds.
public struct VaultTreeNode: Hashable, Sendable, Identifiable {
  public var path: String
  /// What the explorer shows: a note's name without `.md`, else the file or folder name.
  public var name: String
  public var kind: VaultEntryKind
  /// Folders first, then natural name order. Always empty for files.
  public var children: [VaultTreeNode]

  public init(path: String, name: String, kind: VaultEntryKind, children: [VaultTreeNode] = []) {
    self.path = path
    self.name = name
    self.kind = kind
    self.children = children
  }

  public var id: String { path }
  public var isFolder: Bool { kind == .folder }
  /// Children for SwiftUI's `OutlineGroup`/`List(children:)`: nil for files, so they get no
  /// disclosure triangle.
  public var outlineChildren: [VaultTreeNode]? { isFolder ? children : nil }
}

/// A node as a row of a flattened outline (for `List`/`LazyVStack` with manual expansion).
public struct VaultTreeRow: Hashable, Sendable, Identifiable {
  public var path: String
  public var name: String
  public var kind: VaultEntryKind
  /// 0 for top-level entries.
  public var depth: Int
  public var hasChildren: Bool
  public var isExpanded: Bool

  public var id: String { path }
}

/// The explorer tree, port of the web app's `features/explorer/tree.ts` (Obsidian's order).
public enum VaultTree {
  /// Nests `entries` under their folders (folders implied by file paths are created even when not
  /// listed) and sorts every level: folders first, then case- and accent-insensitive natural
  /// order of the names (`Day 2` < `Day 10`), then of the paths, then code units, so the result
  /// doesn't depend on the input order.
  public static func build(_ entries: some Sequence<VaultEntry>, locale: Locale = .current) -> [VaultTreeNode] {
    var folders: Set<ExactString> = [ExactString("")]
    var children: [ExactString: [(path: String, kind: VaultEntryKind)]] = [:]
    func addFolder(_ path: String) {
      guard folders.insert(ExactString(path)).inserted else { return }
      let parent = VaultPath.dirname(path)
      addFolder(parent)
      children[ExactString(parent), default: []].append((path, .folder))
    }
    for entry in entries {
      if entry.kind == .folder {
        addFolder(entry.path)
      } else {
        let parent = VaultPath.dirname(entry.path)
        addFolder(parent)
        children[ExactString(parent), default: []].append((entry.path, .file))
      }
    }
    func nodes(in folder: String) -> [VaultTreeNode] {
      let items = (children[ExactString(folder)] ?? []).map { item in
        VaultTreeNode(
          path: item.path, name: displayName(path: item.path, kind: item.kind), kind: item.kind,
          children: item.kind == .folder ? nodes(in: item.path) : [])
      }
      return items.sorted { compare($0, $1, locale: locale) < 0 }
    }
    return nodes(in: "")
  }

  /// A note's stem, or the base name of anything else.
  public static func displayName(path: String, kind: VaultEntryKind) -> String {
    kind == .file && VaultPath.isMarkdown(path) ? VaultPath.stem(path) : VaultPath.basename(path)
  }

  /// `compareNodes`: folders first, then natural order of names, then of paths, then code units.
  public static func compare(_ a: VaultTreeNode, _ b: VaultTreeNode, locale: Locale = .current) -> Int {
    if a.kind != b.kind { return a.kind == .folder ? -1 : 1 }
    let byName = VaultPath.compare(a.name, b.name, locale: locale)
    if byName != 0 { return byName }
    let byPath = VaultPath.compare(a.path, b.path, locale: locale)
    if byPath != 0 { return byPath }
    return a.path.jsLess(b.path) ? -1 : (b.path.jsLess(a.path) ? 1 : 0)
  }

  /// The node at `path`, found by walking down its ancestor folders.
  public static func node(at path: String, in nodes: [VaultTreeNode]) -> VaultTreeNode? {
    var level = nodes
    for folder in VaultPath.ancestorFolders(path) {
      guard let next = level.first(where: { $0.path.jsEquals(folder) }) else { return nil }
      level = next.children
    }
    return level.first { $0.path.jsEquals(path) }
  }

  /// The folders to expand to reveal `path`, outermost first.
  public static func ancestors(of path: String) -> [String] {
    VaultPath.ancestorFolders(path)
  }

  /// `expanded` plus every ancestor folder of `path`.
  public static func revealing(_ path: String, in expanded: Set<String>) -> Set<String> {
    expanded.union(ancestors(of: path))
  }

  /// The rows a flat outline shows: every node whose ancestors are all in `expanded`.
  public static func visibleRows(_ nodes: [VaultTreeNode], expanded: Set<String>) -> [VaultTreeRow] {
    var rows: [VaultTreeRow] = []
    func visit(_ level: [VaultTreeNode], depth: Int) {
      for node in level {
        let isExpanded = node.isFolder && expanded.contains(node.path)
        rows.append(
          VaultTreeRow(
            path: node.path, name: node.name, kind: node.kind, depth: depth,
            hasChildren: !node.children.isEmpty, isExpanded: isExpanded))
        if isExpanded { visit(node.children, depth: depth + 1) }
      }
    }
    visit(nodes, depth: 0)
    return rows
  }

  /// Every node, depth first, in display order.
  public static func flatten(_ nodes: [VaultTreeNode]) -> [VaultTreeNode] {
    nodes.flatMap { [$0] + flatten($0.children) }
  }
}
