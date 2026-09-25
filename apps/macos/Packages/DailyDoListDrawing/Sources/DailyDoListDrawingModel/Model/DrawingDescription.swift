import Foundation

/// A compact text description of a drawing, a port of `describe.ts` in `@ddl/core` that must give
/// the same bytes (the shared fixtures check it): title and size, text, shapes with their labels,
/// what the arrows connect, lines, freehand strokes and where they are, frames and what they hold.
/// Lengths are counted in Unicode code points.
///
///     Drawing “System” (620×300 px, 9 elements)
///     Text: “Draft”
///     Shapes: rectangle “API”, rectangle “DB”, 1 unlabeled ellipse
///     Arrows: “API” → “DB” labeled “SQL”, arrow from “DB” to near an ellipse
public enum DrawingDescription {
  public static let maxLength = 2000
  static let titleChars = 100
  static let labelChars = 60
  static let nearDistance: Double = 50
  static let truncationNote = "(Shortened: not every item is listed.)"
  static let shapes: [ElementType] = [.rectangle, .ellipse, .diamond]
  static let frames: Set<ElementType> = [.frame, .magicframe]
  static let nearCandidates: Set<ElementType> = [.rectangle, .ellipse, .diamond, .text, .image]
  static let locations = [
    "top left", "top", "top right", "left", "center", "right", "bottom left", "bottom",
    "bottom right",
  ]

  struct Box {
    var minX: Double
    var minY: Double
    var maxX: Double
    var maxY: Double
  }

  struct Section {
    var label: String
    var items: [String]
    var separator: String
  }

  public static func describe(_ scene: ExcalidrawScene, title: String, maxLength: Int = maxLength)
    -> String
  {
    let heading = "Drawing “\(clip(normalize(title), titleChars))”"
    let elements = scene.elements.filter { !$0.isDeleted }
    if elements.isEmpty { return fit(["\(heading) (empty)"], [], maxLength: maxLength) }
    let context = Context(elements)
    let bounds = union(elements.map(box))
    let width = Int(jsRound(bounds.maxX - bounds.minX))
    let height = Int(jsRound(bounds.maxY - bounds.minY))
    let header = "\(heading) (\(width)×\(height) px, \(count(elements.count, "element")))"
    let sections = [
      Section(label: "Text", items: context.freeTexts.map(quote), separator: ", "),
      Section(label: "Shapes", items: context.shapeItems(elements), separator: ", "),
      Section(
        label: "Arrows", items: elements.filter { $0.type == .arrow }.map(context.arrowItem),
        separator: ", "),
      Section(label: "Lines", items: counted(elements, .line, "line", bounds), separator: ", "),
      Section(
        label: "Freehand", items: counted(elements, .freedraw, "freehand stroke", bounds),
        separator: ", "),
      Section(
        label: "Frames", items: elements.filter { frames.contains($0.type) }.map(context.frameItem),
        separator: "; "),
      Section(
        label: "Images", items: nonZero(elements.filter { $0.type == .image }.count, "image"),
        separator: ", "),
      Section(label: "Other", items: context.otherItems(elements), separator: ", "),
    ]
    return fit([header], sections, maxLength: maxLength)
  }

  final class Context {
    var byId: [String: ExcalidrawElement] = [:]
    var order: [String] = []
    var labels: [String: String] = [:]
    var boundTexts = Set<String>()
    var freeTexts: [String] = []
    var candidates: [(element: ExcalidrawElement, box: Box)] = []

    init(_ elements: [ExcalidrawElement]) {
      for element in elements {
        if byId[element.id] == nil { order.append(element.id) }
        byId[element.id] = element
      }
      var boundOrder: [String] = []
      var bound: [String: [String]] = [:]
      for element in elements where element.type == .text {
        if let container = element.containerId, container != element.id, byId[container] != nil {
          boundTexts.insert(element.id)
          if bound[container] == nil { boundOrder.append(container) }
          bound[container, default: []].append(textOf(element))
        }
      }
      for id in boundOrder {
        let label = bound[id]!.filter { !$0.isEmpty }.joined(separator: " / ")
        if !label.isEmpty { labels[id] = clip(label, labelChars) }
      }
      for element in elements {
        if element.type == .text && !boundTexts.contains(element.id) {
          let text = clip(textOf(element), labelChars)
          if !text.isEmpty { freeTexts.append(text) }
        }
        if nearCandidates.contains(element.type) && !boundTexts.contains(element.id) {
          candidates.append((element, box(element)))
        }
      }
    }

    func shapeItems(_ elements: [ExcalidrawElement]) -> [String] {
      var items: [String] = []
      var unlabeled: [ElementType: Int] = [:]
      for element in elements where shapes.contains(element.type) {
        if let label = labels[element.id] {
          items.append("\(element.type.rawValue) \(quote(label))")
        } else {
          unlabeled[element.type, default: 0] += 1
        }
      }
      for type in shapes {
        let n = unlabeled[type] ?? 0
        if n > 0 { items.append("\(n) unlabeled \(plural(type.rawValue, n))") }
      }
      return items
    }

    struct Endpoint {
      var bound: Bool
      var name: String
    }

    func arrowItem(_ arrow: ExcalidrawElement) -> String {
      var from = endpoint(arrow, start: true)
      var to = endpoint(arrow, start: false)
      let startHead = arrow.startArrowhead != nil
      let endHead = arrow.endArrowhead != nil
      if startHead && !endHead { swap(&from, &to) }
      let symbol = startHead && endHead ? "↔" : !startHead && !endHead ? "—" : "→"
      var item: String
      if let from, let to, from.bound, to.bound {
        item = "\(from.name) \(symbol) \(to.name)"
      } else {
        item = "arrow"
        if let from { item += " from \(from.bound ? "" : "near ")\(from.name)" }
        if let to { item += " to \(to.bound ? "" : "near ")\(to.name)" }
      }
      guard let label = labels[arrow.id] else { return item }
      return "\(item) labeled \(quote(label))"
    }

    func frameItem(_ frame: ExcalidrawElement) -> String {
      let name: String
      if let frameName = frame.name, !normalize(frameName).isEmpty {
        name = "frame \(quote(clip(normalize(frameName), labelChars)))"
      } else {
        name = "frame"
      }
      let children = order.compactMap { byId[$0] }.filter {
        $0.frameId == frame.id && !boundTexts.contains($0.id)
      }
      if children.isEmpty { return "\(name) (empty)" }
      var items: [String] = []
      var countOrder: [String] = []
      var counts: [String: Int] = [:]
      for child in children {
        if shapes.contains(child.type), let label = labels[child.id] {
          items.append("\(child.type.rawValue) \(quote(label))")
        } else if child.type == .text && !textOf(child).isEmpty {
          items.append(quote(clip(textOf(child), labelChars)))
        } else {
          let kind =
            shapes.contains(child.type)
            ? "unlabeled \(child.type.rawValue)"
            : child.type == .freedraw ? "freehand stroke" : child.type.rawValue
          if counts[kind] == nil { countOrder.append(kind) }
          counts[kind, default: 0] += 1
        }
      }
      for kind in countOrder { items.append(count(counts[kind]!, kind)) }
      return "\(name) with \(items.joined(separator: ", "))"
    }

    func otherItems(_ elements: [ExcalidrawElement]) -> [String] {
      let known: Set<ElementType> = [
        .rectangle, .ellipse, .diamond, .text, .arrow, .line, .freedraw, .image, .frame,
        .magicframe,
      ]
      var countOrder: [String] = []
      var counts: [String: Int] = [:]
      for element in elements where !known.contains(element.type) {
        if counts[element.type.rawValue] == nil { countOrder.append(element.type.rawValue) }
        counts[element.type.rawValue, default: 0] += 1
      }
      return countOrder.map { count(counts[$0]!, $0) }
    }

    func endpoint(_ arrow: ExcalidrawElement, start: Bool) -> Endpoint? {
      let binding = start ? arrow.startBinding : arrow.endBinding
      if let id = binding?.elementId, let target = byId[id], target.id != arrow.id {
        return Endpoint(bound: true, name: nameOf(target))
      }
      guard let point = endPoint(arrow, start: start) else { return nil }
      var best: (element: ExcalidrawElement, distance: Double, area: Double)?
      for candidate in candidates {
        let dx = max(candidate.box.minX - point.x, 0, point.x - candidate.box.maxX)
        let dy = max(candidate.box.minY - point.y, 0, point.y - candidate.box.maxY)
        let distance = hypot(dx, dy)
        if distance > nearDistance { continue }
        let area =
          (candidate.box.maxX - candidate.box.minX) * (candidate.box.maxY - candidate.box.minY)
        if best == nil || distance < best!.distance
          || (distance == best!.distance && area < best!.area)
        {
          best = (candidate.element, distance, area)
        }
      }
      return best.map { Endpoint(bound: false, name: nameOf($0.element)) }
    }

    func nameOf(_ element: ExcalidrawElement) -> String {
      if let label = labels[element.id] { return quote(label) }
      if element.type == .text {
        let text = clip(textOf(element), labelChars)
        return text.isEmpty ? "a text" : quote(text)
      }
      if frames.contains(element.type) {
        if let name = element.name, !normalize(name).isEmpty {
          return "frame \(quote(clip(normalize(name), labelChars)))"
        }
        return "a frame"
      }
      let type = element.type.rawValue
      let article = type.first.map { "aeiou".contains($0) } == true ? "an" : "a"
      return "\(article) \(type)"
    }
  }

  static func counted(
    _ elements: [ExcalidrawElement], _ type: ElementType, _ noun: String, _ bounds: Box
  )
    -> [String]
  {
    let matching = elements.filter { $0.type == type }
    guard !matching.isEmpty else { return [] }
    var perCell = Array(repeating: 0, count: locations.count)
    for element in matching {
      let b = box(element)
      let cx = (b.minX + b.maxX) / 2
      let cy = (b.minY + b.maxY) / 2
      perCell[cell(cx, bounds.minX, bounds.maxX) + 3 * cell(cy, bounds.minY, bounds.maxY)] += 1
    }
    let places = locations.indices.filter { perCell[$0] > 0 }.map { (locations[$0], perCell[$0]) }
    let total = count(matching.count, noun)
    if places.count == 1 { return ["\(total), \(places[0].0)"] }
    return ["\(total): \(places.map { "\($0.1) \($0.0)" }.joined(separator: ", "))"]
  }

  static func cell(_ value: Double, _ minimum: Double, _ maximum: Double) -> Int {
    let relative = maximum > minimum ? (value - minimum) / (maximum - minimum) : 0.5
    return relative < 1.0 / 3 ? 0 : relative > 2.0 / 3 ? 2 : 1
  }

  /// The header and sections, shortened to `maxLength`.
  static func fit(_ head: [String], _ sections: [Section], maxLength: Int) -> String {
    func render(_ cap: Int) -> String {
      (head
        + sections.filter { !$0.items.isEmpty }.map { section in
          var shown = Array(section.items.prefix(cap))
          let rest = section.items.count - shown.count
          if rest > 0 { shown.append("… and \(rest) more") }
          return "\(section.label): \(shown.joined(separator: section.separator))"
        }).joined(separator: "\n")
    }
    let most = max(0, sections.map(\.items.count).max() ?? 0)
    let full = render(most)
    if length(full) <= maxLength { return full }
    let budget = maxLength - length(truncationNote) - 1
    var low = 0
    var high = most - 1
    while low < high {
      let mid = Int((Double(low + high) / 2).rounded(.up))
      if length(render(mid)) <= budget { low = mid } else { high = mid - 1 }
    }
    let shortened = render(low)
    if length(shortened) <= budget { return "\(shortened)\n\(truncationNote)" }
    let cut = String(String.UnicodeScalarView(shortened.unicodeScalars.prefix(max(0, budget - 1))))
    return "\(cut)…\n\(truncationNote)"
  }

  static func textOf(_ element: ExcalidrawElement) -> String {
    let original = element.text?.originalText ?? ""
    return normalize(original.isEmpty ? (element.text?.text ?? "") : original)
  }

  /// Runs of JavaScript whitespace become one space; one leading and one trailing space go.
  static func normalize(_ text: String) -> String {
    var scalars = String.UnicodeScalarView()
    var inRun = false
    for scalar in text.unicodeScalars {
      if JSWhitespace.contains(scalar) {
        if !inRun { scalars.append(" ") }
        inRun = true
      } else {
        scalars.append(scalar)
        inRun = false
      }
    }
    var result = String(scalars)
    if result.hasPrefix(" ") { result.removeFirst() }
    if result.hasSuffix(" ") { result.removeLast() }
    return result
  }

  static func clip(_ text: String, _ maximum: Int) -> String {
    let scalars = Array(text.unicodeScalars)
    guard scalars.count > maximum else { return text }
    var kept = String(String.UnicodeScalarView(scalars.prefix(maximum - 1)))
    while let last = kept.unicodeScalars.last, JSWhitespace.contains(last) {
      kept.unicodeScalars.removeLast()
    }
    return "\(kept)…"
  }

  static func quote(_ text: String) -> String { "“\(text)”" }
  static func length(_ text: String) -> Int { text.unicodeScalars.count }
  static func count(_ n: Int, _ noun: String) -> String { "\(n) \(plural(noun, n))" }
  static func nonZero(_ n: Int, _ noun: String) -> [String] { n > 0 ? [count(n, noun)] : [] }
  static func plural(_ noun: String, _ n: Int) -> String { n == 1 ? noun : "\(noun)s" }

  static func jsRound(_ value: Double) -> Double {
    let floor = value.rounded(.down)
    return value - floor >= 0.5 ? floor + 1 : floor
  }

  static func points(_ element: ExcalidrawElement) -> [DrawingPoint] {
    if element.type.hasPoints { return element.points }
    // Other types can carry points too (a newer Excalidraw's); read them like the TypeScript.
    return (element.extraField("points")?.arrayValue ?? []).compactMap { item in
      guard let pair = item.arrayValue else { return nil }
      func finite(_ value: JSONValue?) -> Double {
        guard let number = value?.numberValue, number.isFinite else { return 0 }
        return number
      }
      return DrawingPoint(finite(pair.first), finite(pair.count > 1 ? pair[1] : nil))
    }
  }

  static func box(_ element: ExcalidrawElement) -> Box {
    let x = element.x
    let y = element.y
    let list = points(element)
    if !list.isEmpty {
      return union(list.map { Box(minX: x + $0.x, minY: y + $0.y, maxX: x + $0.x, maxY: y + $0.y) })
    }
    return Box(
      minX: min(x, x + element.width), minY: min(y, y + element.height),
      maxX: max(x, x + element.width), maxY: max(y, y + element.height))
  }

  static func endPoint(_ element: ExcalidrawElement, start: Bool) -> DrawingPoint? {
    let list = points(element)
    guard let point = start ? list.first : list.last else { return nil }
    return DrawingPoint(element.x + point.x, element.y + point.y)
  }

  static func union(_ boxes: [Box]) -> Box {
    var result = Box(minX: .infinity, minY: .infinity, maxX: -.infinity, maxY: -.infinity)
    for box in boxes {
      result.minX = min(result.minX, box.minX)
      result.minY = min(result.minY, box.minY)
      result.maxX = max(result.maxX, box.maxX)
      result.maxY = max(result.maxY, box.maxY)
    }
    return result
  }
}
