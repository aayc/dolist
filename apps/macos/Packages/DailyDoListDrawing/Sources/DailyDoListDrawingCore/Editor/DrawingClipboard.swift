import Foundation

public enum DrawingTransferError: Error, LocalizedError {
  case invalid, tooLarge, unreadableFiles, interactionInProgress
  public var errorDescription: String? {
    switch self {
    case .invalid: "The clipboard or library does not contain a readable drawing."
    case .tooLarge: "This drawing transfer exceeds the 32 MB or 10,000 element limit."
    case .unreadableFiles: "The drawing's existing file map is unreadable; it was left unchanged."
    case .interactionInProgress:
      "Finish the current drawing gesture or text edit, then import again."
    }
  }
}

/// Excalidraw's clipboard representation, including referenced files and unknown element fields.
public enum DrawingClipboard {
  public static let contentType = "application/vnd.excalidraw+json"
  public static let maximumBytes = 32 * 1024 * 1024

  public static func encode(_ scene: ExcalidrawScene) -> String {
    var value = SceneCodec.encodeObject(scene)
    value["type"] = .string("excalidraw/clipboard")
    return JSONWriter.string(.object(value))
  }
  public static func decode(_ text: String) throws -> ExcalidrawScene {
    guard text.utf8.count <= maximumBytes else { throw DrawingTransferError.tooLarge }
    let scene = try SceneCodec.decode(text)
    guard ["excalidraw", "excalidraw/clipboard"].contains(scene.type), !scene.elements.isEmpty,
      scene.elements.allSatisfy({ !$0.id.isEmpty }),
      Set(scene.elements.map(\.id)).count == scene.elements.count
    else { throw DrawingTransferError.invalid }
    guard scene.elements.count <= 10_000 else { throw DrawingTransferError.tooLarge }
    return scene
  }
}

extension DrawingEditor {
  public func copiedScene() -> ExcalidrawScene? {
    let ids = withDependents(selectedIds)
    let elements = scene.elements.filter { ids.contains($0.id) && !$0.isDeleted }
    guard !elements.isEmpty else { return nil }
    var files = JSONObject()
    for element in elements {
      if let id = element.fileId, let file = scene.files.objectValue?[id] { files[id] = file }
    }
    return ExcalidrawScene(elements: elements, files: .object(files))
  }

  /// New identities for elements/groups/files prevent collisions, while references within the
  /// pasted subset keep their relationships. No references silently bind to unrelated host IDs.
  @discardableResult
  public func paste(_ payload: ExcalidrawScene, at center: DrawingPoint) throws -> Set<String> {
    let source = payload.elements.filter { !$0.isDeleted }
    guard source.count <= 10_000 else { throw DrawingTransferError.tooLarge }
    guard !source.isEmpty, Set(source.map(\.id)).count == source.count,
      center.x.isFinite, center.y.isFinite, let bounds = ElementGeometry.bounds(of: source)
    else { throw DrawingTransferError.invalid }
    guard var files = scene.files.objectValue, let incomingFiles = payload.files.objectValue else {
      throw DrawingTransferError.unreadableFiles
    }
    finishInteraction()
    let ids = Dictionary(uniqueKeysWithValues: source.map { ($0.id, environment.randomId()) })
    var groups: [String: String] = [:]
    var fileIds: [String: String] = [:]
    for original in source {
      for group in original.groupIds where groups[group] == nil {
        groups[group] = environment.randomId()
      }
      if let id = original.fileId, fileIds[id] == nil, let incoming = incomingFiles[id] {
        var next = id
        if let existing = files[id], existing != incoming { next = environment.randomId() }
        var value = incoming
        if var object = incoming.objectValue {
          object["id"] = .string(next)
          value = .object(object)
        }
        files[next] = value
        fileIds[id] = next
      }
    }
    let offset = center - bounds.center
    for original in source {
      var copy = original
      copy.id = ids[original.id]!
      copy.x += offset.x
      copy.y += offset.y
      copy.groupIds = original.groupIds.compactMap { groups[$0] }
      copy.frameId = original.frameId.flatMap { ids[$0] }
      copy.text?.containerId = original.containerId.flatMap { ids[$0] }
      copy.boundElements = original.boundElements?.compactMap { bound in
        ids[bound.id].map { BoundElement(id: $0, type: bound.type) }
      }
      copy.startBinding = original.startBinding.flatMap { Self.remap($0, ids: ids) }
      copy.endBinding = original.endBinding.flatMap { Self.remap($0, ids: ids) }
      if let fileId = original.fileId, let mapped = fileIds[fileId] {
        copy.setExtraField("fileId", .string(mapped))
      } else if original.fileId != nil {
        // A missing source file must not pick up a different image with the same ID here.
        copy.setExtraField("fileId", .string(environment.randomId()))
        copy.setExtraField("status", .string("error"))
      }
      copy.index = nil
      copy.version = 1
      copy.versionNonce = environment.randomInteger()
      copy.seed = environment.randomInteger()
      copy.updated = environment.now()
      insert(copy)
    }
    scene.files = .object(files)
    let selected = Set(
      source.filter {
        $0.containerId.flatMap { ids[$0] } == nil && $0.frameId.flatMap { ids[$0] } == nil
      }.compactMap { ids[$0.id] })
    tool = .selection
    select(selected)
    commit()
    return selected
  }

  private static func remap(_ binding: PointBinding, ids: [String: String]) -> PointBinding? {
    guard let id = ids[binding.elementId] else { return nil }
    var value = binding
    value.elementId = id
    return value
  }

  public func pasteStyle(from source: ExcalidrawElement) {
    finishInteraction()
    for id in withDependents(editableSelection) {
      guard let current = element(id), !current.locked else { continue }
      update(id) { value in
        value.strokeColor = source.strokeColor
        value.backgroundColor = source.backgroundColor
        value.fillStyle = source.fillStyle
        value.strokeWidth = source.strokeWidth
        value.strokeStyle = source.strokeStyle
        value.roughness = source.roughness
        value.opacity = source.opacity
        value.roundness = source.roundness
        if value.type == .arrow {
          value.startArrowhead = source.startArrowhead
          value.endArrowhead = source.endArrowhead
        }
        if let text = source.text, value.text != nil {
          value.text?.fontSize = text.fontSize
          value.text?.fontFamily = text.fontFamily
          value.text?.textAlign = text.textAlign
          value.text?.verticalAlign = text.verticalAlign
          value.text?.lineHeight = text.lineHeight
        }
      }
      if let text = element(id)?.text {
        if text.containerId != nil {
          layoutLabel(id)
        } else {
          let size = TextLayout.measure(
            text.text, fontSize: text.fontSize, fontFamily: text.fontFamily,
            lineHeight: text.lineHeight)
          update(id) {
            if text.autoResize { $0.width = size.width }
            $0.height = size.height
          }
        }
      }
    }
    syncStyleToSelection()
    commit()
  }

  public func setSelectionLink(_ link: String?) {
    let value = link?.trimmingCharacters(in: .whitespacesAndNewlines)
    for id in editableSelection { update(id) { $0.link = value?.isEmpty == true ? nil : value } }
    commit()
  }
}
