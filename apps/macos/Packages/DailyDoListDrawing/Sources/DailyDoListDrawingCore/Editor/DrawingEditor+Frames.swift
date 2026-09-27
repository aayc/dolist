import Foundation

extension DrawingEditor {
  /// Wraps the complete selection, including labels, in a new frame with a small margin.
  @discardableResult
  public func frameSelection(name: String = "Frame") -> String? {
    finishInteraction()
    let ids = withDependents(editableSelection)
    let members = ids.compactMap { element($0) }.filter { !$0.type.isFrameLike }
    guard !members.isEmpty, let bounds = ElementGeometry.bounds(of: members) else { return nil }
    let box = bounds.insetBy(-20)
    var frame = newElement(.frame, at: DrawingPoint(box.minX, box.minY))
    frame.width = box.width
    frame.height = box.height
    frame.name = name
    insert(frame)
    for member in members { update(member.id) { $0.frameId = frame.id } }
    select([frame.id])
    commit()
    return frame.id
  }

  public func renameFrame(_ id: String, name: String) {
    guard let frame = element(id), frame.type.isFrameLike, !frame.locked, !frame.isDeleted else {
      return
    }
    update(id) { $0.name = name.isEmpty ? nil : name }
    commit()
  }

  public func selectFrameChildren(_ id: String) {
    guard element(id)?.type.isFrameLike == true else { return }
    select(Set(scene.elements.filter { $0.frameId == id && !$0.isDeleted && !$0.locked }.map(\.id)))
  }

  public func removeFrameChildren(_ id: String) {
    guard let frame = element(id), frame.type.isFrameLike, !frame.locked else { return }
    for child in scene.elements where child.frameId == id && !child.isDeleted {
      update(child.id) { $0.frameId = nil }
    }
    commit()
  }

  func replaceFrameChildren(_ id: String) {
    guard let frame = element(id), frame.type.isFrameLike else { return }
    let box = ElementGeometry.bounds(frame)
    for child in scene.elements where !child.type.isFrameLike && !child.isDeleted && !child.locked {
      let contained = box.contains(ElementGeometry.bounds(child))
      if contained {
        update(child.id) { $0.frameId = id }
      } else if child.frameId == id {
        update(child.id) { $0.frameId = nil }
      }
    }
  }

  func updateFrameMembership(resizing: Bool = false) {
    let frames = scene.elements.filter { $0.type.isFrameLike && !$0.isDeleted }
    for frame in frames where selectedIds.contains(frame.id) {
      // Moving a frame keeps its children; resizing updates which objects its rectangle holds.
      if resizing { replaceFrameChildren(frame.id) }
    }
    let selectedFrames = Set(frames.filter { selectedIds.contains($0.id) }.map(\.id))
    for id in withDependents(selectedIds) {
      guard let value = element(id), !value.type.isFrameLike,
        value.frameId.map({ !selectedFrames.contains($0) }) ?? true
      else { continue }
      let frame = frames.reversed().first {
        ElementGeometry.bounds($0).contains(ElementGeometry.bounds(value))
      }
      update(id) { $0.frameId = frame?.id }
    }
  }

  public func setCanvasBackground(_ color: String) {
    scene.appState["viewBackgroundColor"] = .string(color)
    commit()
  }

  public func clearCanvas() {
    finishInteraction()
    delete(Set(scene.elements.filter { !$0.isDeleted }.map(\.id)))
    commit()
  }
}
