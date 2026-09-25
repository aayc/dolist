import Foundation

/// Accessibility attribute and role names the helper reads (the values of the `kAX…` constants).
enum AX {
  static let role = "AXRole"
  static let subrole = "AXSubrole"
  static let title = "AXTitle"
  static let description = "AXDescription"
  static let label = "AXLabel"
  static let labelValue = "AXLabelValue"
  static let placeholder = "AXPlaceholderValue"
  static let help = "AXHelp"
  static let value = "AXValue"
  static let enabled = "AXEnabled"
  static let focused = "AXFocused"
  static let position = "AXPosition"
  static let size = "AXSize"
  static let url = "AXURL"
  static let windows = "AXWindows"
  static let focusedWindow = "AXFocusedWindow"
  static let mainWindow = "AXMainWindow"
  /// Electron apps only build their accessibility tree when an assistive app sets this.
  static let manualAccessibility = "AXManualAccessibility"

  static let secureTextField = "AXSecureTextField"
  static let webArea = "AXWebArea"
  static let unknownRole = "AXUnknown"

  /// Where an element's name comes from, in order: the first non-empty one wins.
  static let nameAttributes = [title, description, label, labelValue, placeholder, help]
}

/// The actions `press` accepts, by protocol name, and the accessibility action each one performs.
public enum ElementAction: String, CaseIterable, Sendable {
  case press
  case showMenu = "show-menu"
  case confirm
  case cancel
  case increment
  case decrement
  case raise
  case pick
  case scrollToVisible = "scroll-to-visible"

  public var accessibilityName: String {
    switch self {
    case .press: "AXPress"
    case .showMenu: "AXShowMenu"
    case .confirm: "AXConfirm"
    case .cancel: "AXCancel"
    case .increment: "AXIncrement"
    case .decrement: "AXDecrement"
    case .raise: "AXRaise"
    case .pick: "AXPick"
    case .scrollToVisible: "AXScrollToVisible"
    }
  }

  init?(accessibilityName: String) {
    guard let action = Self.allCases.first(where: { $0.accessibilityName == accessibilityName })
    else { return nil }
    self = action
  }

  /// The protocol names of an element's actions, in `allCases` order; actions the helper can't
  /// perform (custom and vendor actions) are left out.
  static func names(fromAccessibilityNames names: [String]) -> [String] {
    let supported = Set(names.compactMap(ElementAction.init(accessibilityName:)))
    return allCases.filter(supported.contains).map(\.rawValue)
  }
}
