import Foundation

extension DrawingEditor {
  /// `BOUND_TEXT_PADDING`.
  static let boundTextPadding: Double = 5

  public func beginTextEditing(_ id: String) {
    guard let element = element(id), element.type == .text else { return }
    editingTextId = id
    invalidate()
    onBeginTextEditing?(id)
  }

  /// Double-clicking a shape or an arrow edits its label, making one if it has none.
  public func editLabel(of containerId: String) {
    guard let container = element(containerId), container.type.isTextContainer else { return }
    if let labelId = container.boundTextId, element(labelId) != nil {
      select([containerId])
      beginTextEditing(labelId)
      return
    }
    var label = newElement(.text, at: DrawingPoint(container.x, container.y))
    label.text?.textAlign = .center
    label.text?.verticalAlign = .middle
    label.text?.containerId = containerId
    label.strokeColor = container.strokeColor
    label.height = (label.text?.lineHeightPx ?? 25)
    insert(label, after: containerId)
    update(containerId) { element in
      var bound = element.boundElements ?? []
      bound.append(BoundElement(id: label.id, type: "text"))
      element.boundElements = bound
    }
    layoutLabel(label.id)
    select([containerId])
    beginTextEditing(label.id)
  }

  /// Live text while the inline editor types (not committed until editing ends).
  public func updateEditingText(_ text: String) {
    guard let id = editingTextId, let element = element(id), element.text != nil else { return }
    let normalized = TextLayout.normalize(text)
    if element.containerId != nil {
      update(id) { $0.text?.originalText = normalized }
      layoutLabel(id)
    } else {
      update(id) { element in
        guard var properties = element.text else { return }
        properties.originalText = normalized
        properties.text =
          properties.autoResize
          ? normalized
          : TextLayout.wrap(
            normalized, fontSize: properties.fontSize, fontFamily: properties.fontFamily,
            maxWidth: element.width)
        let size = TextLayout.measure(
          properties.text, fontSize: properties.fontSize, fontFamily: properties.fontFamily,
          lineHeight: properties.lineHeight)
        if properties.autoResize { element.width = size.width }
        element.height = size.height
        element.text = properties
      }
    }
    invalidate()
  }

  /// Ends inline editing: empty text is removed, anything else committed.
  public func endTextEditing() {
    guard let id = editingTextId else { return }
    editingTextId = nil
    if let element = element(id),
      (element.text?.originalText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    {
      let wasCommitted = committedElements.contains { $0.id == id }
      if wasCommitted {
        delete([id])
      } else {
        if let container = element.containerId {
          update(container) { target in
            let kept = target.boundElements?.filter { $0.id != id }
            target.boundElements = kept?.isEmpty == true ? nil : kept
          }
        }
        removeUncommitted(id)
        selectedIds.remove(id)
      }
    }
    commit()
  }

  /// Wraps and places a container's label (`redrawTextBoundingBox`), growing the container when
  /// the text doesn't fit.
  func layoutLabel(_ labelId: String) {
    guard let label = element(labelId), let properties = label.text,
      let containerId = properties.containerId,
      let container = element(containerId)
    else { return }
    if container.type == .arrow {
      update(labelId) { element in
        let maxWidth = max(0.7 * container.width, properties.fontSize * 11)
        element.text?.text = TextLayout.wrap(
          properties.originalText, fontSize: properties.fontSize, fontFamily: properties.fontFamily,
          maxWidth: maxWidth)
        let size = TextLayout.measure(
          element.text!.text, fontSize: properties.fontSize, fontFamily: properties.fontFamily,
          lineHeight: properties.lineHeight)
        element.width = size.width
        element.height = size.height
      }
      positionArrowLabel(labelId)
      return
    }
    let maxWidth = Self.boundTextMaxWidth(container)
    let wrapped = TextLayout.wrap(
      properties.originalText, fontSize: properties.fontSize, fontFamily: properties.fontFamily,
      maxWidth: maxWidth)
    let size = TextLayout.measure(
      wrapped, fontSize: properties.fontSize, fontFamily: properties.fontFamily,
      lineHeight: properties.lineHeight)
    if size.height > Self.boundTextMaxHeight(container) {
      let height = Self.containerDimension(for: size.height, type: container.type)
      update(containerId) { $0.height = height }
    }
    if size.width > maxWidth {
      let width = Self.containerDimension(for: size.width, type: container.type)
      update(containerId) { $0.width = width }
    }
    update(labelId) { element in
      element.text?.text = wrapped
      element.width = size.width
      element.height = size.height
      element.angle = container.angle
    }
    positionContainerLabel(labelId)
    updateArrowsBound(to: [containerId])
  }

  /// `computeBoundTextPosition` for shapes.
  func positionContainerLabel(_ labelId: String) {
    guard let label = element(labelId), let properties = label.text,
      let containerId = properties.containerId,
      let container = element(containerId), container.type != .arrow
    else { return }
    var offsetX = Self.boundTextPadding
    var offsetY = Self.boundTextPadding
    if container.type == .ellipse {
      offsetX += container.width / 2 * (1 - sqrt(2) / 2)
      offsetY += container.height / 2 * (1 - sqrt(2) / 2)
    }
    if container.type == .diamond {
      offsetX += container.width / 4
      offsetY += container.height / 4
    }
    let maxHeight = Self.boundTextMaxHeight(container)
    let maxWidth = Self.boundTextMaxWidth(container)
    let x: Double
    let y: Double
    switch properties.verticalAlign {
    case .top: y = container.y + offsetY
    case .bottom: y = container.y + offsetY + (maxHeight - label.height)
    default: y = container.y + offsetY + (maxHeight / 2 - label.height / 2)
    }
    switch properties.textAlign {
    case .left: x = container.x + offsetX
    case .right: x = container.x + offsetX + (maxWidth - label.width)
    default: x = container.x + offsetX + (maxWidth / 2 - label.width / 2)
    }
    update(labelId) { element in
      element.x = x
      element.y = y
    }
  }

  /// An arrow's label sits on its middle point (or the middle of its middle segment).
  func positionArrowLabel(_ labelId: String) {
    guard let label = element(labelId), let containerId = label.containerId,
      let arrow = element(containerId), arrow.type == .arrow, !arrow.points.isEmpty
    else { return }
    let points = arrow.points
    let middle: DrawingPoint
    if points.count % 2 == 1 {
      middle = points[points.count / 2]
    } else {
      let index = points.count / 2 - 1
      middle = (points[index] + points[index + 1]) * 0.5
    }
    let center = DrawingPoint(arrow.x + middle.x, arrow.y + middle.y)
    update(labelId) { element in
      element.x = center.x - element.width / 2
      element.y = center.y - element.height / 2
    }
  }

  /// `getBoundTextMaxWidth`.
  static func boundTextMaxWidth(_ container: ExcalidrawElement) -> Double {
    switch container.type {
    case .ellipse: ((container.width / 2) * sqrt(2)).rounded() - boundTextPadding * 2
    case .diamond: (container.width / 2).rounded() - boundTextPadding * 2
    default: container.width - boundTextPadding * 2
    }
  }

  /// `getBoundTextMaxHeight`.
  static func boundTextMaxHeight(_ container: ExcalidrawElement) -> Double {
    switch container.type {
    case .ellipse: ((container.height / 2) * sqrt(2)).rounded() - boundTextPadding * 2
    case .diamond: (container.height / 2).rounded() - boundTextPadding * 2
    default: container.height - boundTextPadding * 2
    }
  }

  /// `computeContainerDimensionForBoundText`.
  static func containerDimension(for dimension: Double, type: ElementType) -> Double {
    let dimension = dimension.rounded(.up)
    let padding = boundTextPadding * 2
    switch type {
    case .ellipse: return ((dimension + padding) / sqrt(2) * 2).rounded()
    case .arrow: return dimension + padding * 8
    case .diamond: return 2 * (dimension + padding)
    default: return dimension + padding
    }
  }
}
