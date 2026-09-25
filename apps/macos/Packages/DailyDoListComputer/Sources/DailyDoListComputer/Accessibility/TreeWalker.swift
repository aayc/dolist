import Foundation

/// Bounds of one walk: nodes (the root included), depth below the root, and a deadline for apps
/// that answer slowly.
struct WalkLimits: Sendable {
  var maxNodes: Int
  var maxDepth: Int
  var deadline: ContinuousClock.Instant
}

struct WalkedNode: Sendable {
  var element: AccessibilityElement
  var info: ElementInfo
  /// Depth below the walk's root (the root is 0).
  var depth: Int
  /// Indices of the children that were read, in the app's order.
  var children: [Int] = []
  /// Children that weren't read (their own descendants aren't counted).
  var omittedChildren = 0
}

struct WalkResult: Sendable {
  /// Breadth-first order; `nodes[0]` is the root.
  var nodes: [WalkedNode]
  /// Whether anything was left out (depth, node budget, deadline).
  var truncated: Bool

  /// Node indices in document order (each node before its children).
  var preorder: [Int] {
    var order: [Int] = []
    var stack = [0]
    while let index = stack.popLast() {
      order.append(index)
      stack.append(contentsOf: nodes[index].children.reversed())
    }
    return order
  }
}

/// Reads an element's subtree breadth-first, so the node budget covers a window's whole structure
/// (toolbars, sidebars, the message field) before any single deep branch; the result prints in
/// document order. An element met twice (apps with cyclic trees) is read once.
struct TreeWalker {
  let api: any AccessibilityAPI
  let clock: any ComputerClock
  /// Sees every element read; throwing stops the walk (the protected-target check).
  let inspect: (ElementInfo) throws -> Void

  /// Throws the root's `AccessibilityError` when the root can't be read, or what `inspect` throws.
  func walk(from root: AccessibilityElement, limits: WalkLimits) throws -> WalkResult {
    let rootInfo = try ElementReader.read(root, using: api)
    try inspect(rootInfo)
    var nodes = [WalkedNode(element: root, info: rootInfo, depth: 0)]
    var visited: Set<AccessibilityElement> = [root]
    var queue: [(element: AccessibilityElement, depth: Int, parent: Int)] = []
    var head = 0
    var truncated = false

    func enqueueChildren(of index: Int) {
      let node = nodes[index]
      let room = limits.maxNodes - nodes.count - (queue.count - head)
      guard node.depth < limits.maxDepth, room > 0 else {
        let count = (try? api.childCount(of: node.element)) ?? 0
        if count > 0 {
          nodes[index].omittedChildren += count
          truncated = true
        }
        return
      }
      let children = (try? api.children(of: node.element, limit: room)) ?? []
      var total = children.count
      if children.count == room {
        total = max(total, (try? api.childCount(of: node.element)) ?? total)
      }
      if total > children.count {
        nodes[index].omittedChildren += total - children.count
        truncated = true
      }
      for child in children where visited.insert(child).inserted {
        queue.append((child, node.depth + 1, index))
      }
    }

    enqueueChildren(of: 0)
    while head < queue.count {
      let item = queue[head]
      head += 1
      guard nodes.count < limits.maxNodes, clock.now < limits.deadline else {
        nodes[item.parent].omittedChildren += 1
        truncated = true
        continue
      }
      let info: ElementInfo
      do {
        info = try ElementReader.read(item.element, using: api)
      } catch {
        // A vanished element just isn't there; one that doesn't answer counts as left out.
        if error != .invalidElement {
          nodes[item.parent].omittedChildren += 1
          truncated = true
        }
        continue
      }
      try inspect(info)
      let index = nodes.count
      nodes.append(WalkedNode(element: item.element, info: info, depth: item.depth))
      nodes[item.parent].children.append(index)
      enqueueChildren(of: index)
    }
    return WalkResult(nodes: nodes, truncated: truncated)
  }
}
