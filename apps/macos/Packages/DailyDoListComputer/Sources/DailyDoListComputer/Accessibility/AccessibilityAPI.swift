import Foundation

/// An accessibility element, opaque to everything but the `AccessibilityAPI` that made it. Equal
/// handles denote the same UI object (for the live API, `CFEqual` of the `AXUIElement`s).
public struct AccessibilityElement: Hashable, @unchecked Sendable {
  public let raw: AnyHashable

  public init(_ raw: AnyHashable) {
    self.raw = raw
  }
}

/// An attribute value, reduced to the types the helper uses.
public enum AccessibilityValue: Equatable, Sendable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case point(Point)
  case size(Size)
  case url(URL)
  case element(AccessibilityElement)
  case elements([AccessibilityElement])
  /// A value of a type the helper doesn't read (ranges, attributed strings, …).
  case other
}

/// `AXError`s, by what they mean to the helper.
public enum AccessibilityError: Error, Equatable, Sendable {
  /// The element is gone (`kAXErrorInvalidUIElement`).
  case invalidElement
  /// The app didn't answer in time or messaging failed (`kAXErrorCannotComplete`).
  case cannotComplete
  /// No Accessibility permission (`kAXErrorAPIDisabled`).
  case apiDisabled
  case attributeUnsupported
  case actionUnsupported
  case notImplemented
  case noValue
  case illegalArgument
  case failure(Int32)
}

/// The accessibility API (`AXUIElement`), so tree walking, snapshots and actions run against a
/// fake tree in tests. Calls are synchronous IPC to the target app, bounded by a messaging
/// timeout in the live implementation.
public protocol AccessibilityAPI: Sendable {
  func applicationElement(pid: Int32) -> AccessibilityElement
  /// Reads several attributes in one round trip. Attributes the element doesn't have (or that
  /// fail individually) are absent from the result; the call only throws when the element as a
  /// whole can't be read.
  func attributes(_ names: [String], of element: AccessibilityElement) throws(AccessibilityError)
    -> [String: AccessibilityValue]
  func childCount(of element: AccessibilityElement) throws(AccessibilityError) -> Int
  /// The first `limit` children, in order.
  func children(of element: AccessibilityElement, limit: Int) throws(AccessibilityError)
    -> [AccessibilityElement]
  func actionNames(of element: AccessibilityElement) throws(AccessibilityError) -> [String]
  func isSettable(_ attribute: String, of element: AccessibilityElement) throws(AccessibilityError)
    -> Bool
  func performAction(_ action: String, on element: AccessibilityElement) throws(AccessibilityError)
  func setAttribute(
    _ attribute: String, to value: AccessibilityValue, on element: AccessibilityElement
  ) throws(AccessibilityError)
}
