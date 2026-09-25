import Foundation
import Observation

/// Keys held during a pointer event.
public struct PointerModifiers: OptionSet, Hashable, Sendable {
  public let rawValue: Int
  public init(rawValue: Int) { self.rawValue = rawValue }

  public static let shift = PointerModifiers(rawValue: 1 << 0)
  public static let option = PointerModifiers(rawValue: 1 << 1)
  public static let command = PointerModifiers(rawValue: 1 << 2)
  public static let control = PointerModifiers(rawValue: 1 << 3)
}

/// The editing state of one drawing and everything a user can do to it: tools, selection,
/// moving, resizing, drawing shapes, lines, arrows (binding to shapes), freehand strokes and
/// text, erasing, styles, undo and redo. Platform-neutral: the canvas view feeds it pointer
/// positions in scene coordinates and keys, and draws what it says.
///
/// Every change bumps the element's `version`, `versionNonce` and `updated` like Excalidraw's
/// `mutateElement`; a gesture's end (or a command) commits: it's recorded for undo and reported
/// through ``onChange``.
@MainActor
@Observable
public final class DrawingEditor {
  /// The scene as it is now (mid-gesture included). Not observed: ``onInvalidate`` says when it
  /// changed.
  @ObservationIgnored public internal(set) var scene: ExcalidrawScene
  public var tool: DrawingTool = .selection {
    didSet { if tool != oldValue { toolDidChange() } }
  }
  /// Q: tools stay active after drawing.
  public var isToolLocked = false
  /// What new elements are drawn with (and what the properties panel shows).
  public internal(set) var style = ElementStyle()
  public internal(set) var selectedIds: Set<String> = []
  public internal(set) var hoveredId: String?
  public internal(set) var marquee: DrawingRect?
  /// The shape an arrow being drawn would attach to.
  public internal(set) var bindingHighlightId: String?
  /// Elements the eraser will remove on release (drawn faded).
  public internal(set) var erasingIds: Set<String> = []
  public internal(set) var editingTextId: String?
  /// A line or arrow drawn click by click (its last point follows the pointer).
  public internal(set) var multiPointElementId: String?
  public internal(set) var canUndo = false
  public internal(set) var canRedo = false
  /// Screen pixels per scene unit, for hit tolerances (set by the view).
  @ObservationIgnored public var zoom: Double = 1

  /// After each committed change, with the scene to save.
  @ObservationIgnored public var onChange: ((ExcalidrawScene) -> Void)?
  /// After any change that needs a redraw.
  @ObservationIgnored public var onInvalidate: (() -> Void)?
  /// The host should show an inline editor for this text element.
  @ObservationIgnored public var onBeginTextEditing: ((String) -> Void)?
  /// Inline text editing ended (committed, discarded, or ended by another action).
  @ObservationIgnored public var onEndTextEditing: (() -> Void)?

  @ObservationIgnored let environment: DrawingEnvironment
  @ObservationIgnored var history = DrawingHistory()
  @ObservationIgnored var committedElements: [ExcalidrawElement]
  @ObservationIgnored var committedSelection: Set<String> = []
  @ObservationIgnored var indexById: [String: Int] = [:]
  @ObservationIgnored var gesture: Gesture?
  /// The shape the first point of a line drawn click by click was on.
  @ObservationIgnored var multiPointStartTarget: String?
  /// Increments on every change (views compare it to know whether to redraw).
  @ObservationIgnored public internal(set) var revision = 0

  public init(scene: ExcalidrawScene, environment: DrawingEnvironment = SystemDrawingEnvironment())
  {
    self.scene = scene
    self.environment = environment
    self.committedElements = scene.elements
    rebuildIndex()
  }

  // MARK: Scene access

  public func element(_ id: String) -> ExcalidrawElement? {
    indexById[id].map { scene.elements[$0] }
  }

  var elementsById: [String: ExcalidrawElement] {
    var result: [String: ExcalidrawElement] = [:]
    result.reserveCapacity(scene.elements.count)
    for element in scene.elements where !element.isDeleted { result[element.id] = element }
    return result
  }

  public var selectedElements: [ExcalidrawElement] {
    scene.elements.filter { selectedIds.contains($0.id) && !$0.isDeleted }
  }

  func rebuildIndex() {
    indexById.removeAll(keepingCapacity: true)
    for (index, element) in scene.elements.enumerated() { indexById[element.id] = index }
  }

  /// Replaces the scene (the file changed on disk). Undo history is kept only if nothing
  /// changed underneath it; the selection keeps the elements still there.
  public func replaceScene(_ newScene: ExcalidrawScene, keepHistory: Bool = false) {
    cancelGesture()
    scene = newScene
    committedElements = newScene.elements
    rebuildIndex()
    selectedIds = selectedIds.filter { element($0).map { !$0.isDeleted } ?? false }
    committedSelection = selectedIds
    if !keepHistory { history.clear() }
    updateHistoryFlags()
    invalidate()
  }

  // MARK: Mutations

  /// Changes one element; bumps its version when something changed.
  func update(_ id: String, _ change: (inout ExcalidrawElement) -> Void) {
    guard let index = indexById[id] else { return }
    var element = scene.elements[index]
    let before = element
    change(&element)
    guard element != before else { return }
    element.bumpVersion(in: environment)
    scene.elements[index] = element
    revision += 1
  }

  /// Adds an element at the top of the z-order (or after `afterId`).
  func insert(_ element: ExcalidrawElement, after afterId: String? = nil) {
    var element = element
    let position = afterId.flatMap { indexById[$0].map { $0 + 1 } } ?? scene.elements.count
    let previous = scene.elements[..<position].last {
      $0.index.map(FractionalIndex.isValid) ?? false
    }?.index
    let next = scene.elements[position...].first { $0.index.map(FractionalIndex.isValid) ?? false }?
      .index
    element.index = FractionalIndex.key(between: previous, and: next)
    scene.elements.insert(element, at: position)
    rebuildIndex()
    revision += 1
  }

  func invalidate() {
    revision += 1
    onInvalidate?()
  }

  /// Records the changes since the last commit for undo and reports the scene.
  func commit() {
    if let entry = DrawingHistory.diff(
      from: committedElements, to: scene.elements, selectionBefore: committedSelection,
      selectionAfter: selectedIds)
    {
      history.record(entry)
      committedElements = scene.elements
      committedSelection = selectedIds
      updateHistoryFlags()
      invalidate()
      onChange?(scene)
    } else {
      committedSelection = selectedIds
      invalidate()
    }
  }

  func updateHistoryFlags() {
    canUndo = history.canUndo
    canRedo = history.canRedo
  }

  public func undo() {
    finishInteraction()
    guard let entry = history.popUndo() else { return }
    scene.elements = DrawingHistory.apply(
      entry.before, order: entry.orderBefore, to: scene.elements, environment: environment)
    afterHistoryStep(selection: entry.selectionBefore)
  }

  public func redo() {
    finishInteraction()
    guard let entry = history.popRedo() else { return }
    scene.elements = DrawingHistory.apply(
      entry.after, order: entry.orderAfter, to: scene.elements, environment: environment)
    afterHistoryStep(selection: entry.selectionAfter)
  }

  private func afterHistoryStep(selection: Set<String>) {
    rebuildIndex()
    committedElements = scene.elements
    selectedIds = selection.filter { element($0).map { !$0.isDeleted } ?? false }
    committedSelection = selectedIds
    syncStyleToSelection()
    updateHistoryFlags()
    invalidate()
    onChange?(scene)
  }

  /// Ends whatever is in progress (a text edit, a line drawn by clicks, a gesture).
  public func finishInteraction() {
    if editingTextId != nil { endTextEditing() }
    if multiPointElementId != nil { finishMultiPoint() }
    if gesture != nil { cancelGesture() }
  }

  // MARK: Selection

  public func select(_ ids: Set<String>) {
    let expanded = expandToGroups(ids).filter { element($0).map { !$0.isDeleted } ?? false }
    guard expanded != selectedIds else { return }
    selectedIds = expanded
    syncStyleToSelection()
    invalidate()
  }

  public func selectAll() {
    finishInteraction()
    select(
      Set(scene.elements.filter { !$0.isDeleted && !$0.locked && $0.containerId == nil }.map(\.id)))
  }

  public func clearSelection() { select([]) }

  /// Clicking an element of a group selects the group (its outermost one).
  func expandToGroups(_ ids: Set<String>) -> Set<String> {
    var groups = Set<String>()
    for id in ids { if let group = element(id)?.groupIds.last { groups.insert(group) } }
    guard !groups.isEmpty else { return ids }
    var result = ids
    for element in scene.elements where !element.isDeleted {
      if let group = element.groupIds.last, groups.contains(group) { result.insert(element.id) }
    }
    return result
  }

  func toolDidChange() {
    finishInteraction()
    if tool != .selection && tool != .hand { clearSelection() }
    hoveredId = nil
    invalidate()
  }

  /// The ids an operation on the selection touches: the selection, labels of selected
  /// containers, and children of selected frames.
  func withDependents(_ ids: Set<String>) -> Set<String> {
    var result = ids
    for id in ids {
      guard let element = element(id) else { continue }
      if let label = element.boundTextId { result.insert(label) }
      if element.type.isFrameLike {
        for child in scene.elements where child.frameId == id && !child.isDeleted {
          result.insert(child.id)
          if let label = child.boundTextId { result.insert(label) }
        }
      }
    }
    return result
  }

  /// Hit tolerance in scene units (10 screen pixels).
  var threshold: Double { 10 / zoom }
}
