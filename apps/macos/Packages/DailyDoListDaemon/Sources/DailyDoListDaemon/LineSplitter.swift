import Foundation

/// Turns a byte stream into lines. Bytes are buffered until a newline, so multi-byte UTF-8
/// characters split across reads decode correctly; `\r\n` endings lose the `\r`; very long lines
/// are truncated.
struct LineSplitter {
  static let maxLineLength = 4_000

  private var pending = Data()

  mutating func append(_ data: Data) -> [String] {
    pending.append(data)
    var lines: [String] = []
    while let newline = pending.firstIndex(of: 0x0A) {
      lines.append(Self.decode(pending[pending.startIndex..<newline]))
      pending.removeSubrange(pending.startIndex...newline)
    }
    // A runaway line without newlines must not grow without bound.
    if pending.count > Self.maxLineLength * 4 {
      lines.append(Self.decode(pending))
      pending.removeAll()
    }
    return lines
  }

  /// The trailing partial line, if any (call at end of stream).
  mutating func flush() -> [String] {
    guard !pending.isEmpty else { return [] }
    defer { pending.removeAll() }
    return [Self.decode(pending)]
  }

  private static func decode(_ bytes: Data) -> String {
    var line = String(decoding: bytes, as: UTF8.self)
    if line.hasSuffix("\r") { line.removeLast() }
    if line.count > maxLineLength { line = String(line.prefix(maxLineLength)) + "…" }
    return line
  }
}

/// The last `capacity` lines.
struct LogRingBuffer: Sendable {
  let capacity: Int
  private(set) var lines: [String] = []

  init(capacity: Int) {
    self.capacity = max(1, capacity)
  }

  mutating func append<S: Sequence>(contentsOf newLines: S) where S.Element == String {
    lines.append(contentsOf: newLines)
    if lines.count > capacity { lines.removeFirst(lines.count - capacity) }
  }

  mutating func removeAll() { lines.removeAll() }
}
