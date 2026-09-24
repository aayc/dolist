import DailyDoListDomain
import Foundation
import Testing

/// Loads the JSON vectors generated from the TypeScript core by
/// apps/macos/scripts/generate-vectors.ts (read from the source tree, not bundled).
enum Vectors {
  static let directory: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // Support
    .deletingLastPathComponent()  // DailyDoListDomainTests
    .appendingPathComponent("Vectors")

  /// The zone the generator formats times in.
  static let timeZone = TimeZone(identifier: "America/Los_Angeles")!

  static func load<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
    let data = try Data(contentsOf: directory.appendingPathComponent(name))
    return try JSONDecoder().decode(T.self, from: data)
  }

  /// `YYYY-MM-DD`, possibly with signed out-of-range fields (`-0001-01-01`, `2026--1-05`).
  static func date(_ text: String) -> LocalDate {
    var fields: [Int] = []
    var index = text.startIndex
    while index < text.endIndex {
      var end = text.index(after: index)  // keeps a leading minus sign with its field
      while end < text.endIndex && text[end] != "-" { end = text.index(after: end) }
      fields.append(Int(text[index..<end])!)
      index = end < text.endIndex ? text.index(after: end) : end
    }
    precondition(fields.count == 3, "bad vector date \(text)")
    return LocalDate(year: fields[0], month: fields[1], day: fields[2])
  }

  static func date(ms: Int) -> Date {
    Date(timeIntervalSince1970: Double(ms) / 1000)
  }
}

/// JavaScript string identity: same code units (Swift's `==` also equates NFC and NFD).
func same(_ a: String?, _ b: String?) -> Bool {
  switch (a, b) {
  case (nil, nil): true
  case (let a?, let b?): a.utf8.elementsEqual(b.utf8)
  default: false
  }
}

func same(_ a: [String], _ b: [String]) -> Bool {
  a.count == b.count && zip(a, b).allSatisfy { same($0, $1) }
}

/// Runs a throwing call into a typed `Result`.
func attempt<T>(_ body: () throws(InvalidPathError) -> T) -> Result<T, InvalidPathError> {
  do {
    return .success(try body())
  } catch {
    return .failure(error)
  }
}

/// Collects mismatches of one vector file and reports them as a single issue with samples, so a
/// regression doesn't bury the output under thousands of failures.
struct VectorCheck {
  let name: String
  private(set) var total = 0
  private(set) var failures = 0
  private var samples: [String] = []

  init(_ name: String) {
    self.name = name
  }

  mutating func expect(_ ok: Bool, _ message: @autoclosure () -> String) {
    total += 1
    guard !ok else { return }
    failures += 1
    if samples.count < 15 { samples.append(message()) }
  }

  func verify(atLeast minimum: Int = 1, sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(total >= minimum, "\(name): only \(total) cases checked", sourceLocation: sourceLocation)
    if failures > 0 {
      Issue.record(
        Comment(rawValue: "\(name): \(failures) of \(total) cases differ from the TypeScript core:\n"
          + samples.joined(separator: "\n")),
        sourceLocation: sourceLocation)
    }
  }
}

/// A JSON array decoded element by element (vectors use tuples to stay compact).
struct Tuple {
  private var container: UnkeyedDecodingContainer

  init(_ decoder: Decoder) throws {
    container = try decoder.unkeyedContainer()
  }

  mutating func next<T: Decodable>(_ type: T.Type = T.self) throws -> T {
    try container.decode(T.self)
  }

  mutating func optional<T: Decodable>(_ type: T.Type = T.self) throws -> T? {
    try container.decodeNil() ? nil : container.decode(T.self)
  }

  mutating func date() throws -> LocalDate {
    Vectors.date(try next(String.self))
  }

  mutating func optionalDate() throws -> LocalDate? {
    try optional(String.self).map(Vectors.date)
  }
}

extension String {
  /// Debug rendering that shows invisible characters.
  var debug: String { debugDescription }
}
