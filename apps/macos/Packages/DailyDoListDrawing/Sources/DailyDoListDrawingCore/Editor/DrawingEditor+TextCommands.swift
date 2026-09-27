import Foundation

extension DrawingEditor {
  public var selectedTextElements: [ExcalidrawElement] {
    withDependents(editableSelection).compactMap { element($0) }.filter {
      $0.text != nil && !$0.locked
    }
  }

  public func setTextVerticalAlignment(_ alignment: VerticalAlign) {
    finishInteraction()
    for text in selectedTextElements {
      update(text.id) { $0.text?.verticalAlign = alignment }
      if text.containerId != nil { layoutLabel(text.id) }
    }
    commit()
  }

  public func setTextAutoResize(_ enabled: Bool) {
    finishInteraction()
    for element in selectedTextElements where element.containerId == nil {
      guard var text = element.text else { continue }
      text.autoResize = enabled
      text.text =
        enabled
        ? text.originalText
        : TextLayout.wrap(
          text.originalText, fontSize: text.fontSize, fontFamily: text.fontFamily,
          maxWidth: element.width)
      let size = TextLayout.measure(
        text.text, fontSize: text.fontSize,
        fontFamily: text.fontFamily, lineHeight: text.lineHeight)
      update(element.id) {
        $0.text = text
        if enabled { $0.width = size.width }
        $0.height = size.height
      }
    }
    commit()
  }

  /// Existing free text becomes the selected shape's label without replacing its words.
  @discardableResult
  public func bindSelectedText() -> Bool {
    finishInteraction()
    let selected = editableSelection.compactMap { element($0) }
    guard selected.count == 2,
      let text = selected.first(where: { $0.type == .text && $0.containerId == nil }),
      let container = selected.first(where: { $0.type.isTextContainer && $0.boundTextId == nil })
    else { return false }
    bindText(text.id, to: container.id)
    select([container.id])
    commit()
    return true
  }

  public func unbindSelectedText() {
    finishInteraction()
    for text in selectedTextElements {
      guard let containerId = text.containerId else { continue }
      update(containerId) { $0.boundElements?.removeAll { $0.id == text.id } }
      update(text.id) { $0.text?.containerId = nil }
    }
    commit()
  }

  public func wrapSelectedText() {
    finishInteraction()
    var result: Set<String> = []
    for text in selectedTextElements where text.containerId == nil {
      var container = newElement(.rectangle, at: DrawingPoint(text.x - 10, text.y - 10))
      container.width = text.width + 20
      container.height = text.height + 20
      container.angle = text.angle
      container.frameId = text.frameId
      container.groupIds = text.groupIds
      insert(container)
      // Containers precede their labels in the scene's paint order.
      if let from = scene.elements.firstIndex(where: { $0.id == container.id }),
        let to = scene.elements.firstIndex(where: { $0.id == text.id })
      {
        let value = scene.elements.remove(at: from)
        scene.elements.insert(value, at: to)
        rebuildIndex()
      }
      bindText(text.id, to: container.id)
      result.insert(container.id)
    }
    if !result.isEmpty { select(result) }
    commit()
  }

  private func bindText(_ textId: String, to containerId: String) {
    let frameId = element(containerId)?.frameId
    update(textId) {
      $0.text?.containerId = containerId
      $0.text?.verticalAlign = .middle
      $0.text?.textAlign = .center
      $0.frameId = frameId
    }
    update(containerId) {
      var bound = $0.boundElements ?? []
      bound.append(BoundElement(id: textId, type: "text"))
      $0.boundElements = bound
    }
    layoutLabel(textId)
  }
}
