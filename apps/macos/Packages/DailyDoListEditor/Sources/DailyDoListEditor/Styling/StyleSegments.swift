import Foundation

/// Flattens a line's (possibly nested) spans and markers into consecutive runs with one combined
/// style each, via a sweep over span boundaries (linear-logarithmic even for pathological lines).
enum StyleSegments {
  struct Segment: Equatable {
    var length: Int
    var style: InlineStyle
    var marker: MarkerKind?
  }

  private struct Event {
    var position: Int
    var delta: Int
    var style: InlineStyle
    var marker: MarkerKind?
  }

  static func build(_ tokens: LineTokens, length: Int) -> [Segment] {
    guard length > 0 else { return [] }
    if tokens.spans.isEmpty, tokens.markers.isEmpty {
      return [Segment(length: length, style: [], marker: nil)]
    }
    var events: [Event] = []
    events.reserveCapacity((tokens.spans.count + tokens.markers.count) * 2)
    func add(_ range: NSRange, _ style: InlineStyle, _ marker: MarkerKind?) {
      let start = max(0, min(range.location, length))
      let end = max(start, min(range.end, length))
      guard end > start else { return }
      events.append(Event(position: start, delta: 1, style: style, marker: marker))
      events.append(Event(position: end, delta: -1, style: style, marker: marker))
    }
    for span in tokens.spans { add(span.range, span.style, nil) }
    for marker in tokens.markers { add(marker.range, [], marker.kind) }
    events.sort { $0.position < $1.position }

    var styleCounts = [Int](repeating: 0, count: 16)
    var markerCounts = [Int](repeating: 0, count: MarkerKind.allCases.count + 1)
    var segments: [Segment] = []
    var position = 0
    var next = 0
    while position < length {
      while next < events.count, events[next].position <= position {
        let event = events[next]
        var bits = event.style.rawValue
        var bit = 0
        while bits != 0 {
          if bits & 1 == 1 { styleCounts[bit] += event.delta }
          bits >>= 1
          bit += 1
        }
        if let marker = event.marker { markerCounts[marker.rawValue] += event.delta }
        next += 1
      }
      let end = next < events.count ? min(events[next].position, length) : length
      var style = InlineStyle()
      for bit in 0..<styleCounts.count where styleCounts[bit] > 0 {
        style.insert(InlineStyle(rawValue: 1 << UInt16(bit)))
      }
      var marker: MarkerKind?
      for kind in MarkerKind.allCases where markerCounts[kind.rawValue] > 0 { marker = kind }
      if let last = segments.last, last.style == style, last.marker == marker {
        segments[segments.count - 1].length += end - position
      } else {
        segments.append(Segment(length: end - position, style: style, marker: marker))
      }
      position = end
    }
    return segments
  }
}
