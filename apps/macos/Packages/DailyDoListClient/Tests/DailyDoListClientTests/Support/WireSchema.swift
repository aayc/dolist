import DailyDoListClientTestSupport
import DailyDoListModels
import Foundation

/// Validates JSON against the generated contract schema (`packages/contract/schema/wire.schema.json`)
/// in *exact* mode: an object may only carry keys its schema declares, like the contract's
/// `exact()` conformance tests hold producers to. Supports what the export uses: `$ref`,
/// `oneOf`/`anyOf`, `type`, `const`, `enum`, `properties`/`required`, `items` and their count,
/// numeric bounds, string lengths (UTF-16, like JavaScript) and `pattern`.
struct WireSchema: Sendable {
  let definitions: [String: JSONValue]

  static let contractDirectory: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("../../../../../../../packages/contract")
    .standardizedFileURL

  static func load() throws -> WireSchema {
    let url = contractDirectory.appendingPathComponent("schema/wire.schema.json")
    let root = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    guard case .object(let definitions)? = root["$defs"] else {
      throw TimeoutError(description: "no $defs in \(url.path)")
    }
    return WireSchema(definitions: definitions)
  }

  /// Issues (`path: problem`), empty when `value` conforms to definition `name`.
  func validate(_ value: JSONValue, as name: String) -> [String] {
    var issues: [String] = []
    check(value, against: ["$ref": .string("#/$defs/\(name)")], at: name, into: &issues)
    return issues
  }

  func validate(_ value: some Encodable, as name: String) -> [String] {
    do {
      return validate(try JSONValue(encoding: value), as: name)
    } catch {
      return ["\(name): could not encode (\(error))"]
    }
  }

  func definition(_ name: String) -> JSONValue? { definitions[name] }

  /// Declared property names of an object definition.
  func properties(of name: String) -> Set<String> {
    guard case .object(let properties)? = definitions[name]?["properties"] else { return [] }
    return Set(properties.keys)
  }

  /// Whether the `ServerEvent` union has a branch for events of `type`.
  func declaresEvent(_ type: String) -> Bool {
    guard case .array(let branches)? = definitions["ServerEvent"]?["oneOf"] else { return false }
    return branches.map(resolve).contains {
      $0["properties"]?["type"]?["const"] == .string(type)
    }
  }

  /// Required property names of an object definition.
  func required(of name: String) -> Set<String> {
    guard case .array(let keys)? = definitions[name]?["required"] else { return [] }
    return Set(keys.compactMap(\.stringValue))
  }

  private func resolve(_ schema: JSONValue) -> JSONValue {
    guard let ref = schema["$ref"]?.stringValue, ref.hasPrefix("#/$defs/"),
      let target = definitions[String(ref.dropFirst("#/$defs/".count))]
    else { return schema }
    return resolve(target)
  }

  private func check(
    _ value: JSONValue, against raw: JSONValue, at path: String, into issues: inout [String]
  ) {
    let schema = resolve(raw)
    guard case .object(let keywords) = schema else { return }

    if case .array(let options)? = keywords["oneOf"] ?? keywords["anyOf"] {
      // Discriminated unions: validate against the branch whose `type`/`kind` const matches.
      let branches = options.map(resolve)
      for discriminator in ["type", "kind"] {
        guard let tag = value[discriminator],
          let branch = branches.first(where: { $0["properties"]?[discriminator]?["const"] == tag })
        else { continue }
        check(value, against: branch, at: path, into: &issues)
        return
      }
      var best: [String]?
      for branch in branches {
        var branchIssues: [String] = []
        check(value, against: branch, at: path, into: &branchIssues)
        if branchIssues.isEmpty { return }
        if best == nil || branchIssues.count < best?.count ?? 0 { best = branchIssues }
      }
      issues += best ?? ["\(path): matches no alternative"]
      return
    }

    if let type = keywords["type"], !Self.matches(value, type: type) {
      issues.append("\(path): expected \(type.jsonString), got \(value.jsonString.prefix(80))")
      return
    }
    if let constant = keywords["const"], value != constant {
      issues.append("\(path): expected \(constant.jsonString), got \(value.jsonString.prefix(80))")
    }
    if case .array(let allowed)? = keywords["enum"], !allowed.contains(value) {
      issues.append(
        "\(path): \(value.jsonString) is not one of \(JSONValue.array(allowed).jsonString)")
    }
    switch value {
    case .string(let string):
      let length = string.utf16.count
      if let min = keywords["minLength"]?.numberValue, Double(length) < min {
        issues.append("\(path): shorter than \(Int(min))")
      }
      if let max = keywords["maxLength"]?.numberValue, Double(length) > max {
        issues.append("\(path): longer than \(Int(max))")
      }
      if let pattern = keywords["pattern"]?.stringValue, !Self.matches(string, pattern: pattern) {
        issues.append("\(path): \(string.prefix(80).debugDescription) does not match \(pattern)")
      }
    case .number(let number):
      if let min = keywords["minimum"]?.numberValue, number < min {
        issues.append("\(path): \(number) < \(min)")
      }
      if let max = keywords["maximum"]?.numberValue, number > max {
        issues.append("\(path): \(number) > \(max)")
      }
    case .array(let items):
      if let min = keywords["minItems"]?.numberValue, Double(items.count) < min {
        issues.append("\(path): fewer than \(Int(min)) items")
      }
      if let max = keywords["maxItems"]?.numberValue, Double(items.count) > max {
        issues.append("\(path): more than \(Int(max)) items")
      }
      if let itemSchema = keywords["items"] {
        for (index, item) in items.enumerated() {
          check(item, against: itemSchema, at: "\(path)[\(index)]", into: &issues)
        }
      }
    case .object(let object):
      let properties: [String: JSONValue] =
        if case .object(let declared)? = keywords["properties"] { declared } else { [:] }
      if case .array(let required)? = keywords["required"] {
        for case .string(let key) in required where object[key] == nil {
          issues.append("\(path): missing \(key)")
        }
      }
      if keywords["properties"] != nil {
        for key in object.keys.sorted() where properties[key] == nil {
          issues.append("\(path): undeclared key \(key)")
        }
      }
      for (key, propertySchema) in properties {
        if let child = object[key] {
          check(child, against: propertySchema, at: "\(path).\(key)", into: &issues)
        }
      }
    default:
      break
    }
  }

  private static func matches(_ value: JSONValue, type: JSONValue) -> Bool {
    if case .array(let types) = type { return types.contains { matches(value, type: $0) } }
    switch (type.stringValue, value) {
    case ("string", .string), ("boolean", .bool), ("null", .null), ("object", .object),
      ("array", .array):
      return true
    case ("number", .number): return true
    case ("integer", .number(let number)):
      return number.rounded() == number && abs(number) <= 9_007_199_254_740_991
    default: return false
    }
  }

  private static func matches(_ string: String, pattern: String) -> Bool {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
    let range = NSRange(string.startIndex..., in: string)
    return regex.firstMatch(in: string, range: range) != nil
  }
}

extension JSONValue {
  /// The JSON the daemon encoders produce for `value`.
  init(encoding value: some Encodable) throws {
    self = try JSONDecoder.daemon.decode(JSONValue.self, from: JSONEncoder.daemon.encode(value))
  }

  var objectKeys: Set<String> {
    if case .object(let object) = self { return Set(object.keys) }
    return []
  }
}
