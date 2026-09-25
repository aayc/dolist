import ApplicationServices
import Foundation

/// The accessibility API. Every call is IPC to the target app, so the process-wide messaging
/// timeout bounds how long a hung app can hold a request.
public struct LiveAccessibility: AccessibilityAPI {
  /// Seconds an app has to answer one accessibility call (macOS's default is 6).
  public static let messagingTimeout: Float = 2

  public init() {
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), Self.messagingTimeout)
  }

  public func applicationElement(pid: Int32) -> AccessibilityElement {
    wrap(AXUIElementCreateApplication(pid))
  }

  public func attributes(_ names: [String], of element: AccessibilityElement)
    throws(AccessibilityError) -> [String: AccessibilityValue]
  {
    let target = try unwrap(element)
    var values: CFArray?
    let status = AXUIElementCopyMultipleAttributeValues(
      target, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
    guard status == .success else { throw Self.error(status) }
    guard let array = values as? [AnyObject] else { return [:] }
    var result: [String: AccessibilityValue] = [:]
    for (name, value) in zip(names, array) {
      if let converted = convert(value) { result[name] = converted }
    }
    return result
  }

  public func childCount(of element: AccessibilityElement) throws(AccessibilityError) -> Int {
    var count: CFIndex = 0
    let status = AXUIElementGetAttributeValueCount(
      try unwrap(element), kAXChildrenAttribute as CFString, &count)
    switch status {
    case .success: return count
    case .attributeUnsupported, .noValue: return 0
    default: throw Self.error(status)
    }
  }

  public func children(of element: AccessibilityElement, limit: Int) throws(AccessibilityError)
    -> [AccessibilityElement]
  {
    guard limit > 0 else { return [] }
    var values: CFArray?
    let status = AXUIElementCopyAttributeValues(
      try unwrap(element), kAXChildrenAttribute as CFString, 0, limit, &values)
    switch status {
    case .success: break
    case .attributeUnsupported, .noValue: return []
    default: throw Self.error(status)
    }
    return ((values as? [AnyObject]) ?? []).compactMap { value in
      CFGetTypeID(value) == AXUIElementGetTypeID() ? wrap(value as! AXUIElement) : nil
    }
  }

  public func actionNames(of element: AccessibilityElement) throws(AccessibilityError) -> [String] {
    var names: CFArray?
    let status = AXUIElementCopyActionNames(try unwrap(element), &names)
    guard status == .success else { throw Self.error(status) }
    return (names as? [String]) ?? []
  }

  public func isSettable(_ attribute: String, of element: AccessibilityElement)
    throws(AccessibilityError) -> Bool
  {
    var settable: DarwinBoolean = false
    let status = AXUIElementIsAttributeSettable(
      try unwrap(element), attribute as CFString, &settable)
    guard status == .success else { throw Self.error(status) }
    return settable.boolValue
  }

  public func performAction(_ action: String, on element: AccessibilityElement)
    throws(AccessibilityError)
  {
    let status = AXUIElementPerformAction(try unwrap(element), action as CFString)
    guard status == .success else { throw Self.error(status) }
  }

  public func setAttribute(
    _ attribute: String, to value: AccessibilityValue, on element: AccessibilityElement
  ) throws(AccessibilityError) {
    let raw: CFTypeRef
    switch value {
    case .string(let string): raw = string as CFString
    case .number(let number): raw = NSNumber(value: number)
    case .bool(let bool): raw = (bool ? kCFBooleanTrue : kCFBooleanFalse) as CFBoolean
    default: throw .illegalArgument
    }
    let status = AXUIElementSetAttributeValue(try unwrap(element), attribute as CFString, raw)
    guard status == .success else { throw Self.error(status) }
  }

  // MARK: - Conversion

  private func wrap(_ element: AXUIElement) -> AccessibilityElement {
    AccessibilityElement(ElementBox(element: element))
  }

  private func unwrap(_ element: AccessibilityElement) throws(AccessibilityError) -> AXUIElement {
    guard let box = element.raw.base as? ElementBox else { throw .illegalArgument }
    return box.element
  }

  private func convert(_ value: AnyObject) -> AccessibilityValue? {
    let type = CFGetTypeID(value)
    if type == AXValueGetTypeID() {
      let axValue = value as! AXValue
      switch AXValueGetType(axValue) {
      case .cgPoint:
        var point = CGPoint.zero
        guard AXValueGetValue(axValue, .cgPoint, &point) else { return nil }
        return .point(Point(x: Double(point.x), y: Double(point.y)))
      case .cgSize:
        var size = CGSize.zero
        guard AXValueGetValue(axValue, .cgSize, &size) else { return nil }
        return .size(Size(width: Double(size.width), height: Double(size.height)))
      case .axError:
        return nil
      default:
        return .other
      }
    }
    if type == CFStringGetTypeID() { return .string(value as! String) }
    if type == CFBooleanGetTypeID() { return .bool(CFBooleanGetValue((value as! CFBoolean))) }
    if type == CFNumberGetTypeID() { return .number((value as! NSNumber).doubleValue) }
    if type == CFURLGetTypeID() { return .url(value as! URL) }
    if type == AXUIElementGetTypeID() { return .element(wrap(value as! AXUIElement)) }
    if type == CFAttributedStringGetTypeID() {
      return .string((value as! NSAttributedString).string)
    }
    if type == CFArrayGetTypeID() {
      let items = (value as? [AnyObject]) ?? []
      let elements = items.compactMap { item in
        CFGetTypeID(item) == AXUIElementGetTypeID() ? wrap(item as! AXUIElement) : nil
      }
      return elements.count == items.count ? .elements(elements) : .other
    }
    if type == CFNullGetTypeID() { return nil }
    return .other
  }

  static func error(_ status: AXError) -> AccessibilityError {
    switch status {
    case .invalidUIElement, .invalidUIElementObserver: .invalidElement
    case .cannotComplete: .cannotComplete
    case .apiDisabled: .apiDisabled
    case .attributeUnsupported, .parameterizedAttributeUnsupported: .attributeUnsupported
    case .actionUnsupported: .actionUnsupported
    case .notImplemented: .notImplemented
    case .noValue: .noValue
    case .illegalArgument: .illegalArgument
    default: .failure(status.rawValue)
    }
  }
}

/// An `AXUIElement` compared the way the accessibility API compares them.
private struct ElementBox: Hashable, @unchecked Sendable {
  let element: AXUIElement

  static func == (lhs: ElementBox, rhs: ElementBox) -> Bool { CFEqual(lhs.element, rhs.element) }

  func hash(into hasher: inout Hasher) { hasher.combine(CFHash(element)) }
}
