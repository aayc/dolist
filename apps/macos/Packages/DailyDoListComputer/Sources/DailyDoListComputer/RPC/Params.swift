import Foundation

/// Strict reading of one request's params: unknown keys, wrong types and out-of-range values are
/// `invalid`, with a message naming the method and the parameter. `null` counts as absent.
struct Params: Sendable {
  let method: String
  private let object: JSONObject

  init(method: String, object: JSONObject, allowed: Set<String>) throws {
    for key in object.keys where !allowed.contains(key) {
      throw ComputerError.invalid("\(method): unknown parameter \"\(key.prefix(40))\".")
    }
    self.method = method
    self.object = object
  }

  func value(_ key: String) -> JSONValue? {
    guard let value = object[key], value != .null else { return nil }
    return value
  }

  func has(_ key: String) -> Bool { value(key) != nil }

  func integer(_ key: String, in range: ClosedRange<Int>) throws -> Int? {
    guard let value = value(key) else { return nil }
    guard case .number(let number) = value, number == number.rounded(),
      number >= Double(range.lowerBound), number <= Double(range.upperBound)
    else {
      throw ComputerError.invalid(
        "\(method): \"\(key)\" must be an integer from \(range.lowerBound) to \(range.upperBound).")
    }
    return Int(number)
  }

  func requiredInteger(_ key: String, in range: ClosedRange<Int>) throws -> Int {
    guard let value = try integer(key, in: range) else { throw missing(key) }
    return value
  }

  func number(_ key: String, in range: ClosedRange<Double>) throws -> Double? {
    guard let value = value(key) else { return nil }
    guard case .number(let number) = value, number.isFinite, range.contains(number) else {
      throw ComputerError.invalid(
        "\(method): \"\(key)\" must be a number from \(JSONValue.format(range.lowerBound)) to "
          + "\(JSONValue.format(range.upperBound)).")
    }
    return number
  }

  func requiredNumber(_ key: String, in range: ClosedRange<Double>) throws -> Double {
    guard let value = try number(key, in: range) else { throw missing(key) }
    return value
  }

  /// A string of at most `maxLength` UTF-16 units (JavaScript's `length`).
  func string(_ key: String, maxLength: Int, allowEmpty: Bool = false) throws -> String? {
    guard let value = value(key) else { return nil }
    guard case .string(let string) = value else {
      throw ComputerError.invalid("\(method): \"\(key)\" must be a string.")
    }
    if string.isEmpty && !allowEmpty {
      throw ComputerError.invalid("\(method): \"\(key)\" must not be empty.")
    }
    guard string.utf16.count <= maxLength else {
      throw ComputerError.invalid(
        "\(method): \"\(key)\" is too long (\(string.utf16.count) > \(maxLength) characters).")
    }
    return string
  }

  func requiredString(_ key: String, maxLength: Int, allowEmpty: Bool = false) throws -> String {
    guard let value = try string(key, maxLength: maxLength, allowEmpty: allowEmpty) else {
      throw missing(key)
    }
    return value
  }

  func choice(_ key: String, from options: [String]) throws -> String? {
    guard let string = try string(key, maxLength: 64) else { return nil }
    guard options.contains(string) else {
      throw ComputerError.invalid(
        "\(method): \"\(key)\" must be one of \(options.joined(separator: ", ")).")
    }
    return string
  }

  /// A process id (a positive 32-bit integer).
  func pid(_ key: String = "pid") throws -> Int32 {
    Int32(try requiredInteger(key, in: 1...Int(Int32.max)))
  }

  func optionalPID(_ key: String = "pid") throws -> Int32? {
    try integer(key, in: 1...Int(Int32.max)).map { Int32($0) }
  }

  /// An element id from a snapshot, like `e12`.
  func elementID(_ key: String = "elementId") throws -> String? {
    try identifier(key, prefix: "e", example: "e12")
  }

  /// A snapshot id, like `s3`.
  func snapshotID(_ key: String = "snapshotId") throws -> String? {
    try identifier(key, prefix: "s", example: "s3")
  }

  private func identifier(_ key: String, prefix: Character, example: String) throws -> String? {
    guard let string = try string(key, maxLength: 16) else { return nil }
    let digits = string.dropFirst()
    guard string.first == prefix, !digits.isEmpty, digits.first != "0",
      digits.allSatisfy({ $0.isASCII && $0.isNumber })
    else {
      throw ComputerError.invalid("\(method): \"\(key)\" must look like \(example).")
    }
    return string
  }

  private func missing(_ key: String) -> ComputerError {
    .invalid("\(method): \"\(key)\" is required.")
  }
}
