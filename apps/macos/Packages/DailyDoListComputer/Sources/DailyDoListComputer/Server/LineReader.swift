import Foundation

/// Splits a byte stream into lines. Bytes are buffered until a newline, so multi-byte UTF-8
/// characters split across reads decode correctly; a trailing `\r` is dropped; a line longer than
/// `maxLineBytes` is reported as `.tooLong` (its bytes are skipped up to the next newline).
struct LineReader {
  let maxLineBytes: Int
  private var pending: [UInt8] = []
  private var skippingLongLine = false

  init(maxLineBytes: Int = RPCCodec.maxRequestBytes) {
    self.maxLineBytes = maxLineBytes
  }

  mutating func append(_ bytes: some Sequence<UInt8>) -> [InputLine] {
    var lines: [InputLine] = []
    for byte in bytes {
      if byte == 0x0A {
        if skippingLongLine {
          skippingLongLine = false
        } else {
          lines.append(.line(Self.decode(pending)))
        }
        pending.removeAll(keepingCapacity: true)
        continue
      }
      guard !skippingLongLine else { continue }
      pending.append(byte)
      if pending.count > maxLineBytes {
        pending.removeAll()
        skippingLongLine = true
        lines.append(.tooLong)
      }
    }
    return lines
  }

  /// The last line, when the input ended without a newline.
  mutating func finish() -> [InputLine] {
    defer { pending.removeAll() }
    guard !pending.isEmpty, !skippingLongLine else { return [] }
    return [.line(Self.decode(pending))]
  }

  private static func decode(_ bytes: [UInt8]) -> String {
    var line = String(decoding: bytes, as: UTF8.self)
    if line.hasSuffix("\r") { line.removeLast() }
    return line
  }
}
