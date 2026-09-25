import Foundation

/// What a snapshot knows about one element.
struct ElementInfo: Equatable, Sendable {
  var role: String
  var subrole: String?
  /// `AXTitle` as the app reports it (a window's title), capped at `ElementLimits.value`.
  var title: String?
  /// The first non-empty of `AX.nameAttributes`, capped at `ElementLimits.name`.
  var name: String?
  /// The value's display form, capped at `ElementLimits.value`; nil when absent or empty. Never
  /// set for secure text fields, whose value is never read.
  var value: String?
  var isSecure: Bool = false
  /// Whether `AXValue` can be set (`setValue`).
  var settable: Bool = false
  /// Protocol action names (`ElementAction`).
  var actions: [String] = []
  var frame: Rect?
  var enabled: Bool = true
  var focused: Bool = false
  /// `AXURL`, read for web areas only (the protected-target check).
  var url: URL?

  /// Whether `other` still looks like the element a snapshot recorded: same role, subrole and
  /// name. Values may change (text being typed); a different label means it's another control.
  func isSameControl(as other: ElementInfo) -> Bool {
    role == other.role && subrole == other.subrole && name == other.name
  }
}

enum ElementLimits {
  /// Longest name in a snapshot, in characters (including the trailing ellipsis).
  static let name = 120
  /// Longest value in a snapshot, in characters (including the trailing ellipsis).
  static let value = 200
}

/// Reads one element: two batched attribute reads (the role first, so a secure text field's value
/// is never requested), its actions, and whether its value is settable.
enum ElementReader {
  /// Roles that take text even while their value is empty (and so may not report one).
  private static let textInputRoles: Set<String> = [
    "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField",
  ]

  static func read(_ element: AccessibilityElement, using api: any AccessibilityAPI)
    throws(AccessibilityError) -> ElementInfo
  {
    let kind = try api.attributes([AX.role, AX.subrole], of: element)
    let role = nonEmpty(kind[AX.role]?.displayString) ?? AX.unknownRole
    let subrole = nonEmpty(kind[AX.subrole]?.displayString)
    let isSecure = role == AX.secureTextField || subrole == AX.secureTextField

    var names = AX.nameAttributes + [AX.enabled, AX.focused, AX.position, AX.size]
    if !isSecure { names.append(AX.value) }
    if role == AX.webArea { names.append(AX.url) }
    let attributes = try api.attributes(names, of: element)

    var info = ElementInfo(role: role, subrole: subrole, isSecure: isSecure)
    info.title = nonEmpty(attributes[AX.title]?.displayString).map {
      truncate($0, to: ElementLimits.value)
    }
    info.name = AX.nameAttributes.lazy
      .compactMap { nonEmpty(attributes[$0]?.displayString?.trimmingCharacters(in: .whitespaces)) }
      .first
      .map { truncate($0, to: ElementLimits.name) }
    if !isSecure {
      info.value = nonEmpty(attributes[AX.value]?.displayString).map {
        truncate($0, to: ElementLimits.value)
      }
    }
    if case .bool(let enabled) = attributes[AX.enabled] { info.enabled = enabled }
    if case .bool(let focused) = attributes[AX.focused] { info.focused = focused }
    if case .point(let origin) = attributes[AX.position], case .size(let size) = attributes[AX.size]
    {
      info.frame = Rect(x: origin.x, y: origin.y, width: size.width, height: size.height)
    }
    switch attributes[AX.url] {
    case .url(let url): info.url = url
    case .string(let string): info.url = URL(string: string)
    default: break
    }

    do {
      info.actions = ElementAction.names(fromAccessibilityNames: try api.actionNames(of: element))
    } catch {
      if error == .invalidElement { throw error }
    }
    if isSecure || attributes[AX.value] != nil || textInputRoles.contains(role) {
      do {
        info.settable = try api.isSettable(AX.value, of: element)
      } catch {
        if error == .invalidElement { throw error }
      }
    }
    return info
  }

  /// `string` cut to `limit` characters, the last one an ellipsis when anything was cut.
  static func truncate(_ string: String, to limit: Int) -> String {
    guard string.count > limit else { return string }
    return String(string.prefix(limit - 1)) + "…"
  }

  private static func nonEmpty(_ string: String?) -> String? {
    guard let string, !string.isEmpty else { return nil }
    return string
  }
}

extension AccessibilityValue {
  /// Text form of scalar values (strings, numbers, booleans, URLs); nil for the rest.
  var displayString: String? {
    switch self {
    case .string(let string): string
    case .number(let number): JSONValue.format(number)
    case .bool(let bool): bool ? "true" : "false"
    case .url(let url): url.absoluteString
    default: nil
    }
  }

  var elementValue: AccessibilityElement? {
    if case .element(let element) = self { return element }
    return nil
  }
}
