import Foundation

extension DrawingEditor {
  /// Embeddable cards retain their standard Excalidraw type/link. The native adapter shows a
  /// local title card; opening content is an explicit action governed by the host's link policy.
  @discardableResult
  public func insertURLCard(_ address: String, at point: DrawingPoint) throws -> String {
    let address = address.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: address),
      ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
      url.host != nil, point.x.isFinite, point.y.isFinite
    else { throw DrawingTransferError.invalid }
    finishInteraction()
    var card = newElement(.embeddable, at: point)
    card.width = 320
    card.height = 180
    card.link = address
    var label = newElement(.text, at: point)
    label.text?.originalText = address
    label.text?.text = address
    label.text?.containerId = card.id
    label.text?.fontFamily = FontFamily.helvetica
    label.text?.fontSize = 16
    label.text?.lineHeight = FontFamily.lineHeight(FontFamily.helvetica)
    label.text?.textAlign = .center
    label.text?.verticalAlign = .middle
    card.boundElements = [BoundElement(id: label.id, type: "text")]
    insert(card)
    insert(label)
    layoutLabel(label.id)
    select([card.id])
    tool = .selection
    commit()
    return card.id
  }
}
