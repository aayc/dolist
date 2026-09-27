import Foundation

extension DrawingEditor {
  public func setElbowSegmentFixed(_ id: String, index: Int, fixed: Bool) {
    guard let arrow = element(id), arrow.elbowed, !arrow.locked, index > 0,
      index < arrow.points.count
    else { return }
    update(id) { value in
      var segments = value.extraField("fixedSegments")?.arrayValue ?? []
      var metadata =
        segments.first { $0.objectValue?["index"]?.numberValue == Double(index) }?.objectValue
        ?? JSONObject()
      segments.removeAll { $0.objectValue?["index"]?.numberValue == Double(index) }
      if fixed {
        metadata["index"] = .number(Double(index))
        metadata["start"] = Self.pointJSON(value.points[index - 1])
        metadata["end"] = Self.pointJSON(value.points[index])
        segments.append(.object(metadata))
      }
      value.setExtraField("fixedSegments", .array(segments))
    }
    if !fixed { routeElbow(id) }
    commit()
  }

  public func rerouteElbow(_ id: String) {
    guard element(id)?.locked == false else { return }
    finishInteraction()
    routeElbow(id)
    commit()
  }

  public func moveElbowSegment(_ id: String, index: Int, by delta: DrawingPoint) {
    guard let arrow = element(id) else { return }
    moveElbowSegment(arrow, index: index, by: delta)
    commit()
  }

  func moveElbowSegment(_ original: ExcalidrawElement, index: Int, by delta: DrawingPoint) {
    guard original.elbowed, !original.locked, original.angle == 0,
      index > 0, index < original.points.count, delta.x.isFinite, delta.y.isFinite
    else { return }
    let a = original.points[index - 1]
    let b = original.points[index]
    let shift = a.x == b.x ? DrawingPoint(delta.x, 0) : DrawingPoint(0, delta.y)
    var segments = original.extraField("fixedSegments")?.arrayValue ?? []
    var metadata =
      segments.first { $0.objectValue?["index"]?.numberValue == Double(index) }?.objectValue
      ?? JSONObject()
    segments.removeAll { $0.objectValue?["index"]?.numberValue == Double(index) }
    metadata["index"] = .number(Double(index))
    metadata["start"] = Self.pointJSON(a + shift)
    metadata["end"] = Self.pointJSON(b + shift)
    segments.append(.object(metadata))
    routeElbow(original.id, fixedSegments: segments)
  }

  /// Fixed segments stay at the user's chosen scene coordinates while endpoint routes adapt.
  @discardableResult
  func routeElbow(_ id: String, fixedSegments: [JSONValue]? = nil) -> Bool {
    guard let arrow = element(id), arrow.elbowed, arrow.points.count >= 2, !arrow.isDeleted else {
      return false
    }
    let first = ArrowBinding.absolutePoint(arrow, 0)
    let last = ArrowBinding.absolutePoint(arrow, arrow.points.count - 1)
    var boxes: [DrawingRect] = []
    func port(_ point: DrawingPoint, target: String?) -> DrawingPoint {
      guard let target, let shape = element(target), !shape.isDeleted else { return point }
      let box = ElementGeometry.bounds(shape)
      let padded = box.insetBy(-16)
      // Overlapping endpoint shapes use their original route, just as the web falls back to
      // point bounds when there is no unambiguous route around both containers.
      boxes.append(padded)
      let distances = [
        abs(point.x - box.minX), abs(point.x - box.maxX), abs(point.y - box.minY),
        abs(point.y - box.maxY),
      ]
      switch distances.indices.min(by: { distances[$0] < distances[$1] }) {
      case 0: return DrawingPoint(padded.minX, point.y)
      case 1: return DrawingPoint(padded.maxX, point.y)
      case 2: return DrawingPoint(point.x, padded.minY)
      default: return DrawingPoint(point.x, padded.maxY)
      }
    }
    let from = port(first, target: arrow.startBinding?.elementId)
    let to = port(last, target: arrow.endBinding?.elementId)
    let sourceFixed = fixedSegments ?? arrow.extraField("fixedSegments")?.arrayValue ?? []
    let fixed = sourceFixed.compactMap {
      value -> (JSONObject, DrawingPoint, DrawingPoint)? in
      guard let object = value.objectValue, let start = Self.readPoint(object["start"]),
        let end = Self.readPoint(object["end"])
      else { return nil }
      let origin = DrawingPoint(arrow.x, arrow.y)
      return (
        object, (start + origin).rotated(around: ElementGeometry.center(arrow), by: arrow.angle),
        (end + origin).rotated(around: ElementGeometry.center(arrow), by: arrow.angle)
      )
    }.sorted { ($0.0["index"]?.numberValue ?? 0) < ($1.0["index"]?.numberValue ?? 0) }
    guard fixed.count == sourceFixed.count else { return false }
    var result = [first, from]
    var current = from
    var nextFixed: [(JSONObject, DrawingPoint, DrawingPoint)] = []
    for (metadata, start, end) in fixed {
      guard start.x == end.x || start.y == end.y,
        let prefix = OrthogonalRouter.route(from: current, to: start, avoiding: boxes)
      else { return false }
      result.append(contentsOf: prefix.dropFirst())
      result.append(end)
      nextFixed.append((metadata, start, end))
      current = end
    }
    guard let suffix = OrthogonalRouter.route(from: current, to: to, avoiding: boxes) else {
      return false
    }
    result.append(contentsOf: suffix.dropFirst())
    result.append(last)
    // Keep fixed-segment endpoints even if they are collinear with neighboring route runs.
    let protected = Set(nextFixed.flatMap { [$0.1, $0.2] })
    var corners: [DrawingPoint] = []
    for point in result {
      if point == corners.last { continue }
      if corners.count >= 2, !protected.contains(corners[corners.count - 1]) {
        let lastThree = OrthogonalRouter.corners([
          corners[corners.count - 2], corners[corners.count - 1], point,
        ])
        if lastThree.count == 2 { corners.removeLast() }
      }
      corners.append(point)
    }
    guard corners.count >= 2 else { return false }
    update(id) { value in
      value.x = first.x
      value.y = first.y
      value.angle = 0
      value.points = corners.map { $0 - first }
      normalizePoints(&value)
      let segments: [JSONValue] = nextFixed.compactMap { metadata, start, end in
        guard
          let index = corners.indices.dropFirst().first(where: {
            corners[$0 - 1] == start && corners[$0] == end
          })
        else { return nil }
        var object = metadata
        object["index"] = .number(Double(index))
        object["start"] = Self.pointJSON(start - first)
        object["end"] = Self.pointJSON(end - first)
        return .object(object)
      }
      value.setExtraField("fixedSegments", .array(segments))
    }
    if editingLinearId == id, let index = selectedPointIndex {
      selectedPointIndex = min(index, corners.count - 1)
    }
    if let label = arrow.boundTextId { positionArrowLabel(label) }
    return true
  }

  func synchronizeFixedSegments(_ arrow: inout ExcalidrawElement) {
    guard let segments = arrow.extraField("fixedSegments")?.arrayValue else { return }
    arrow.setExtraField(
      "fixedSegments",
      .array(
        segments.map { value in
          guard var object = value.objectValue, let index = object["index"]?.numberValue,
            index.isFinite, index > 0, index < Double(arrow.points.count), index.rounded() == index
          else { return value }
          object["start"] = Self.pointJSON(arrow.points[Int(index) - 1])
          object["end"] = Self.pointJSON(arrow.points[Int(index)])
          return .object(object)
        }))
  }
  static func pointJSON(_ point: DrawingPoint) -> JSONValue {
    .array([.number(point.x), .number(point.y)])
  }
  static func readPoint(_ value: JSONValue?) -> DrawingPoint? {
    guard let values = value?.arrayValue, values.count == 2,
      let x = values[0].numberValue, let y = values[1].numberValue, x.isFinite, y.isFinite
    else { return nil }
    return DrawingPoint(x, y)
  }
}
