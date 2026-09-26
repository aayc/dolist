import Foundation

@testable import DailyDoListComputer

/// A fake accessibility tree: nodes with attributes, children, actions and settable attributes.
/// It records every read, action and write, so tests can check what the helper touched.
final class FakeAccessibility: AccessibilityAPI, @unchecked Sendable {
  /// A node to install. `key` names it for later lookups (`element(_:)`, `update(_:)`).
  struct Node {
    var key: String?
    var role: String
    var attributes: [String: AccessibilityValue] = [:]
    var actions: [String] = []
    var settable: Set<String> = []
    var children: [Node] = []

    init(
      _ role: String, key: String? = nil, title: String? = nil, description: String? = nil,
      value: AccessibilityValue? = nil, frame: Rect? = nil, actions: [String] = [],
      settable: Set<String> = [], attributes: [String: AccessibilityValue] = [:],
      children: [Node] = []
    ) {
      self.key = key
      self.role = role
      self.attributes = attributes
      self.attributes[AX.role] = .string(role)
      if let title { self.attributes[AX.title] = .string(title) }
      if let description { self.attributes[AX.description] = .string(description) }
      if let value { self.attributes[AX.value] = value }
      if let frame {
        self.attributes[AX.position] = .point(Point(x: frame.x, y: frame.y))
        self.attributes[AX.size] = .size(Size(width: frame.width, height: frame.height))
      }
      self.actions = actions
      self.settable = settable
      self.children = children
    }
  }

  struct Stored {
    var attributes: [String: AccessibilityValue]
    var actions: [String]
    var settable: Set<String>
    var children: [Int]
    var gone = false
    var hung = false
  }

  enum Call: Equatable {
    case read(key: String, attributes: [String])
    case perform(key: String, action: String)
    case set(key: String, attribute: String, value: AccessibilityValue)
  }

  private let lock = NSLock()
  private var nodes: [Int: Stored] = [:]
  private var keys: [String: Int] = [:]
  private var names: [Int: String] = [:]
  private var appNodes: [Int32: Int] = [:]
  private var nextID = 1
  private var calls: [Call] = []
  /// Attributes an app element accepts writes to (the Electron switch, for instance).
  var appSettable: Set<String> = []

  var recorded: [Call] { lock.withLock { calls } }

  /// Installs an app with `windows` (the first is focused and main unless told otherwise).
  @discardableResult
  func installApp(
    pid: Int32, windows: [Node], focused: Int? = 0, main: Int? = 0, extraChildren: [Node] = []
  ) -> AccessibilityElement {
    lock.withLock {
      let windowIDs = windows.map { add($0) }
      let extraIDs = extraChildren.map { add($0) }
      var attributes: [String: AccessibilityValue] = [
        AX.role: .string("AXApplication"),
        AX.windows: .elements(windowIDs.map(handle)),
      ]
      if let focused, windowIDs.indices.contains(focused) {
        attributes[AX.focusedWindow] = .element(handle(windowIDs[focused]))
      }
      if let main, windowIDs.indices.contains(main) {
        attributes[AX.mainWindow] = .element(handle(windowIDs[main]))
      }
      let id = nextID
      nextID += 1
      nodes[id] = Stored(
        attributes: attributes, actions: [], settable: appSettable,
        children: windowIDs + extraIDs)
      names[id] = "app-\(pid)"
      appNodes[pid] = id
      return handle(id)
    }
  }

  func element(_ key: String) -> AccessibilityElement {
    lock.withLock { handle(keys[key]!) }
  }

  /// Changes a stored node (by key), e.g. to rename it, mark it gone or make it hang.
  func update(_ key: String, _ change: (inout Stored) -> Void) {
    lock.withLock { change(&nodes[keys[key]!]!) }
  }

  /// Makes an existing node also a child of another (apps with cyclic trees do this).
  func link(_ childKey: String, under parentKey: String) {
    lock.withLock { nodes[keys[parentKey]!]!.children.append(keys[childKey]!) }
  }

  /// Changes an app's own element, e.g. to make the whole app hang.
  func updateApp(pid: Int32, _ change: (inout Stored) -> Void) {
    lock.withLock { change(&nodes[appNodes[pid]!]!) }
  }

  func value(of key: String, _ attribute: String) -> AccessibilityValue? {
    lock.withLock { nodes[keys[key]!]!.attributes[attribute] }
  }

  // MARK: - AccessibilityAPI

  func applicationElement(pid: Int32) -> AccessibilityElement {
    lock.withLock { handle(appNodes[pid] ?? -Int(pid)) }
  }

  func attributes(_ names: [String], of element: AccessibilityElement) throws(AccessibilityError)
    -> [String: AccessibilityValue]
  {
    let stored = try node(element)
    lock.withLock { calls.append(.read(key: name(of: element), attributes: names)) }
    var result: [String: AccessibilityValue] = [:]
    for name in names { result[name] = stored.attributes[name] }
    return result
  }

  func childCount(of element: AccessibilityElement) throws(AccessibilityError) -> Int {
    try node(element).children.count
  }

  func children(of element: AccessibilityElement, limit: Int) throws(AccessibilityError)
    -> [AccessibilityElement]
  {
    let stored = try node(element)
    return lock.withLock { stored.children.prefix(max(0, limit)).map(handle) }
  }

  func actionNames(of element: AccessibilityElement) throws(AccessibilityError) -> [String] {
    try node(element).actions
  }

  func isSettable(_ attribute: String, of element: AccessibilityElement) throws(AccessibilityError)
    -> Bool
  {
    try node(element).settable.contains(attribute)
  }

  func performAction(_ action: String, on element: AccessibilityElement) throws(AccessibilityError)
  {
    let stored = try node(element)
    guard stored.actions.contains(action) else { throw .actionUnsupported }
    lock.withLock { calls.append(.perform(key: name(of: element), action: action)) }
  }

  func setAttribute(
    _ attribute: String, to value: AccessibilityValue, on element: AccessibilityElement
  ) throws(AccessibilityError) {
    let stored = try node(element)
    guard stored.settable.contains(attribute) else { throw .attributeUnsupported }
    lock.withLock {
      calls.append(.set(key: name(of: element), attribute: attribute, value: value))
      if let id = element.raw.base as? Int { nodes[id]?.attributes[attribute] = value }
    }
  }

  // MARK: - Internals

  private func node(_ element: AccessibilityElement) throws(AccessibilityError) -> Stored {
    guard let id = element.raw.base as? Int else { throw .illegalArgument }
    let stored = lock.withLock { nodes[id] }
    guard let stored, !stored.gone else { throw .invalidElement }
    if stored.hung { throw .cannotComplete }
    return stored
  }

  private func name(of element: AccessibilityElement) -> String {
    guard let id = element.raw.base as? Int else { return "?" }
    return names[id] ?? "#\(id)"
  }

  /// Call with the lock held.
  private func add(_ node: Node) -> Int {
    let id = nextID
    nextID += 1
    let children = node.children.map { add($0) }
    nodes[id] = Stored(
      attributes: node.attributes, actions: node.actions, settable: node.settable,
      children: children)
    if let key = node.key {
      keys[key] = id
      names[id] = key
    }
    return id
  }

  private func handle(_ id: Int) -> AccessibilityElement { AccessibilityElement(id) }
}
