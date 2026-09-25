import Foundation

/// The snapshot's text form: one element per line, indented two spaces per depth, e.g.
///
///     [e1] AXWindow subrole=AXStandardWindow name="Chat"
///       [e2] AXTextField name="Ask anything" settable focused
///       [e3] AXButton name="Send" disabled actions=press (+2 descendants omitted)
///
/// Names and values are quoted with `\`, `"` and control characters escaped, so every element
/// stays on one line. A secure text field's value is never read and shows as `value=•••`.
enum TreeFormatter {
  static let secureValue = "•••"

  static func line(id: String, info: ElementInfo, omittedChildren: Int) -> String {
    var line = "[\(id)] \(info.role)"
    if let subrole = info.subrole { line += " subrole=\(subrole)" }
    if let name = info.name { line += " name=\(quote(name))" }
    if info.isSecure {
      line += " value=\(secureValue)"
    } else if let value = info.value {
      line += " value=\(quote(value))"
    }
    if info.settable { line += " settable" }
    if info.focused { line += " focused" }
    if !info.enabled { line += " disabled" }
    if !info.actions.isEmpty { line += " actions=\(info.actions.joined(separator: ","))" }
    if omittedChildren > 0 { line += " (+\(omittedChildren) descendants omitted)" }
    return line
  }

  /// The lines of `result` in document order, with each node's id from `ids` (by node index).
  static func render(_ result: WalkResult, ids: [Int: String]) -> String {
    result.preorder.map { index in
      let node = result.nodes[index]
      let indent = String(repeating: "  ", count: node.depth)
      return indent
        + line(id: ids[index] ?? "?", info: node.info, omittedChildren: node.omittedChildren)
    }.joined(separator: "\n")
  }

  /// One entry of a snapshot's `elements`.
  static func elementJSON(id: String, info: ElementInfo) -> JSONValue {
    var object: JSONObject = ["id": .string(id), "role": .string(info.role)]
    if let subrole = info.subrole { object["subrole"] = .string(subrole) }
    if let name = info.name { object["name"] = .string(name) }
    if info.isSecure {
      object["value"] = .string(secureValue)
    } else if let value = info.value {
      object["value"] = .string(value)
    }
    object["settable"] = .bool(info.settable)
    object["actions"] = .array(info.actions.map { .string($0) })
    if let frame = info.frame { object["frame"] = frame.json }
    object["enabled"] = .bool(info.enabled)
    object["focused"] = .bool(info.focused)
    return .object(object)
  }

  static func quote(_ text: String) -> String {
    var out = "\""
    for scalar in text.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        let value = scalar.value
        if value < 0x20 || (0x7F...0x9F).contains(value) || value == 0x2028 || value == 0x2029 {
          out += String(format: "\\u%04x", value)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }
    return out + "\""
  }
}
