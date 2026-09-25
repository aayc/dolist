import Foundation

/// A key the canvas passes on (characters, or one of the special keys).
public enum DrawingKey: Hashable, Sendable {
  case character(Character)
  case delete
  case forwardDelete
  case escape
  case enter
  case left
  case right
  case up
  case down
}

extension DrawingEditor {
  // MARK: Delete and duplicate

  /// Deletes the selection (Delete or Backspace).
  public func deleteSelection() {
    finishInteraction()
    guard !selectedIds.isEmpty else { return }
    delete(selectedIds)
    selectedIds = []
    commit()
  }

  /// Marks elements deleted (tombstones stay for merges), with their labels and frame children,
  /// and detaches what pointed at them.
  func delete(_ ids: Set<String>) {
    let all = withDependents(ids)
    for id in all { update(id) { $0.isDeleted = true } }
    detachReferences(to: all)
    selectedIds.subtract(all)
    invalidate()
  }

  /// Duplicates the selection 10 units down and to the right (⌘D) and selects the copies.
  public func duplicateSelection() {
    finishInteraction()
    guard !selectedIds.isEmpty else { return }
    let copies = duplicate(selectedIds, offset: DrawingPoint(10, 10))
    select(copies)
    commit()
  }

  /// Copies elements (with labels and frame children) above the originals: new ids, seeds and
  /// groups; bindings kept between copies, dropped to anything outside. Returns the copies of
  /// `ids`.
  func duplicate(_ ids: Set<String>, offset: DrawingPoint) -> Set<String> {
    let all = withDependents(ids)
    var idMap: [String: String] = [:]
    var groupMap: [String: String] = [:]
    for id in all { idMap[id] = environment.randomId() }
    let originals = scene.elements.filter { all.contains($0.id) && !$0.isDeleted }
    guard let last = originals.last?.id else { return [] }
    var insertAfter = last
    for original in originals {
      var copy = original
      copy.id = idMap[original.id]!
      copy.x += offset.x
      copy.y += offset.y
      copy.seed = environment.randomInteger()
      copy.version = 1
      copy.versionNonce = environment.randomInteger()
      copy.updated = environment.now()
      copy.groupIds = original.groupIds.map { group in
        if let mapped = groupMap[group] { return mapped }
        let mapped = environment.randomId()
        groupMap[group] = mapped
        return mapped
      }
      if let frameId = original.frameId { copy.frameId = idMap[frameId] ?? frameId }
      copy.boundElements = original.boundElements?.compactMap { bound in
        idMap[bound.id].map { BoundElement(id: $0, type: bound.type) }
      }
      if copy.boundElements?.isEmpty == true { copy.boundElements = nil }
      if let containerId = original.containerId { copy.text?.containerId = idMap[containerId] }
      if let start = original.startBinding {
        copy.startBinding = idMap[start.elementId].map {
          var binding = start
          binding.elementId = $0
          return binding
        }
      }
      if let end = original.endBinding {
        copy.endBinding = idMap[end.elementId].map {
          var binding = end
          binding.elementId = $0
          return binding
        }
      }
      insert(copy, after: insertAfter)
      insertAfter = copy.id
    }
    return Set(ids.compactMap { idMap[$0] })
  }

  // MARK: Nudging

  /// Arrow keys move the selection 1 unit, 5 with shift.
  public func nudgeSelection(dx: Double, dy: Double) {
    guard !selectedIds.isEmpty else { return }
    let ids = withDependents(selectedIds)
    for id in ids {
      update(id) { element in
        element.x += dx
        element.y += dy
      }
    }
    updateArrowsBound(to: ids, movedTogether: ids)
    commit()
  }

  // MARK: Eraser

  func erase(from start: DrawingPoint, to end: DrawingPoint) {
    let steps = max(1, Int(start.distance(to: end) * zoom / 4))
    let byId = elementsById
    var found = erasingIds
    for step in 0...steps {
      let t = Double(step) / Double(steps)
      let point = start + (end - start) * t
      for element in scene.elements.reversed() where !element.isDeleted && !element.locked {
        guard !found.contains(element.id), HitTest.hits(element, point, threshold: threshold / 2)
        else { continue }
        let target = element.containerId.flatMap { byId[$0] } ?? element
        found.insert(target.id)
        if let label = target.boundTextId { found.insert(label) }
      }
    }
    if found != erasingIds {
      erasingIds = found
      invalidate()
    }
  }

  // MARK: Keys

  /// Excalidraw's shortcuts; false when the key isn't the canvas's.
  @discardableResult
  public func handleKey(_ key: DrawingKey, modifiers: PointerModifiers = []) -> Bool {
    guard editingTextId == nil else { return false }
    let command = modifiers.contains(.command)
    switch key {
    case .character(let character):
      let lower = Character(character.lowercased())
      if command {
        switch lower {
        case "z":
          if modifiers.contains(.shift) { redo() } else { undo() }
          return true
        case "y":
          redo()
          return true
        case "d":
          duplicateSelection()
          return true
        case "a":
          selectAll()
          return true
        default:
          return false
        }
      }
      guard modifiers.subtracting(.shift).isEmpty else { return false }
      if lower == "q" {
        isToolLocked.toggle()
        return true
      }
      if let tool = DrawingTool.tool(forKey: lower) {
        self.tool = tool
        return true
      }
      return false
    case .delete, .forwardDelete:
      guard !selectedIds.isEmpty else { return false }
      deleteSelection()
      return true
    case .escape:
      if multiPointElementId != nil {
        finishMultiPoint()
        return true
      }
      if gesture != nil {
        cancelGesture()
        invalidate()
        return true
      }
      if tool != .selection {
        tool = .selection
        return true
      }
      if !selectedIds.isEmpty {
        clearSelection()
        return true
      }
      return false
    case .enter:
      if multiPointElementId != nil {
        finishMultiPoint()
        return true
      }
      if selectedIds.count == 1, let id = selectedIds.first, let element = element(id) {
        if element.type == .text {
          beginTextEditing(id)
          return true
        }
        if element.type.isTextContainer {
          editLabel(of: id)
          return true
        }
      }
      return false
    case .left, .right, .up, .down:
      guard !selectedIds.isEmpty else { return false }
      let step: Double = modifiers.contains(.shift) ? 5 : 1
      switch key {
      case .left: nudgeSelection(dx: -step, dy: 0)
      case .right: nudgeSelection(dx: step, dy: 0)
      case .up: nudgeSelection(dx: 0, dy: -step)
      default: nudgeSelection(dx: 0, dy: step)
      }
      return true
    }
  }

  // MARK: Styles

  /// The style the properties panel shows: the first selected element's, else the current one.
  func syncStyleToSelection() {
    guard let first = selectedElements.first(where: { $0.containerId == nil }) else { return }
    var style = self.style
    style.strokeColor = first.strokeColor
    if first.type != .text && first.type != .arrow { style.backgroundColor = first.backgroundColor }
    style.fillStyle = first.fillStyle
    if first.type != .text {
      style.strokeWidth = first.strokeWidth
      style.strokeStyle = first.strokeStyle
      style.roughness = first.roughness
    }
    style.opacity = first.opacity
    if first.type == .arrow {
      style.startArrowhead = first.startArrowhead
      style.endArrowhead = first.endArrowhead
    }
    if let text = first.text ?? first.boundTextId.flatMap({ element($0)?.text }) {
      style.fontSize = text.fontSize
      style.fontFamily = text.fontFamily
    }
    self.style = style
  }

  /// A property of the style changed: new elements use it, and the selection takes it.
  public func applyStyle(_ change: (inout ElementStyle) -> Void) {
    var newStyle = style
    change(&newStyle)
    let old = style
    style = newStyle
    guard !selectedIds.isEmpty else { return }
    let ids = withDependents(selectedIds)
    for id in ids {
      guard let current = element(id) else { continue }
      update(id) { element in
        if newStyle.strokeColor != old.strokeColor { element.strokeColor = newStyle.strokeColor }
        if newStyle.backgroundColor != old.backgroundColor,
          [.rectangle, .ellipse, .diamond, .line, .freedraw].contains(element.type)
        {
          element.backgroundColor = newStyle.backgroundColor
        }
        if newStyle.fillStyle != old.fillStyle { element.fillStyle = newStyle.fillStyle }
        if element.type != .text {
          if newStyle.strokeWidth != old.strokeWidth { element.strokeWidth = newStyle.strokeWidth }
          if newStyle.strokeStyle != old.strokeStyle { element.strokeStyle = newStyle.strokeStyle }
          if newStyle.roughness != old.roughness { element.roughness = newStyle.roughness }
        }
        if newStyle.opacity != old.opacity { element.opacity = newStyle.opacity }
        if element.type == .arrow {
          if newStyle.startArrowhead != old.startArrowhead {
            element.startArrowhead = newStyle.startArrowhead
          }
          if newStyle.endArrowhead != old.endArrowhead {
            element.endArrowhead = newStyle.endArrowhead
          }
        }
        if newStyle.roundEdges != old.roundEdges,
          [.rectangle, .diamond, .line, .arrow].contains(element.type)
        {
          element.roundness =
            newStyle.roundEdges ? (element.type == .rectangle ? .adaptive : .proportional) : nil
        }
        if var text = element.text,
          newStyle.fontSize != old.fontSize || newStyle.fontFamily != old.fontFamily
        {
          text.fontSize = newStyle.fontSize
          text.fontFamily = newStyle.fontFamily
          text.lineHeight = FontFamily.lineHeight(newStyle.fontFamily)
          element.text = text
          if text.containerId == nil {
            let size = TextLayout.measure(
              text.text, fontSize: text.fontSize, fontFamily: text.fontFamily,
              lineHeight: text.lineHeight)
            if text.autoResize { element.width = size.width }
            element.height = size.height
          }
        }
      }
      if current.containerId != nil { layoutLabel(id) }
    }
    commit()
  }
}
