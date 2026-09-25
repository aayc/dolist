import Foundation

/// Checks that a window isn't showing Daily Do List's web UI: its title, and the URL (`AXURL`) of
/// every web area in it. Web areas are found by a bounded breadth-first search that never descends
/// into web content, collections or plain controls, so it stays cheap. It fails closed: a window
/// it can't finish checking in time is refused.
struct WebUIGuard {
  let targets: ProtectedTargets
  let api: any AccessibilityAPI
  let clock: any ComputerClock
  var maxVisited = 4_000
  var maxDepth = 25
  var timeBudget: Duration = .seconds(4)

  /// Roles that can't hold a web view worth checking (or are long collections of rows).
  static let leafRoles: Set<String> = [
    "AXStaticText", "AXButton", "AXTextField", "AXTextArea", "AXSecureTextField", "AXCheckBox",
    "AXRadioButton", "AXImage", "AXSlider", "AXPopUpButton", "AXMenuButton", "AXComboBox",
    "AXIncrementor", "AXProgressIndicator", "AXBusyIndicator", "AXValueIndicator",
    "AXLevelIndicator", "AXRelevanceIndicator", "AXDisclosureTriangle", "AXColorWell",
    "AXDateField", "AXTimeField", "AXLink", "AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem",
    "AXTable", "AXOutline", "AXList", "AXBrowser", "AXGrid", "AXRow", "AXColumn", "AXCell",
    "AXScrollBar", "AXRuler", "AXSplitter", "AXGrowArea", "AXHandle", "AXToolbar",
  ]

  /// Checks every window of an app (keys and clicks may land in any of them).
  func check(app: AccessibilityElement, appName: String) throws {
    let windows: [AccessibilityElement]
    do {
      if case .elements(let list) = try api.attributes([AX.windows], of: app)[AX.windows] {
        windows = list
      } else {
        windows = []
      }
    } catch {
      throw error.asAppError(appName: appName)
    }
    for window in windows {
      try check(window: window, appName: appName)
    }
  }

  /// Throws `protected` when `window` shows Daily Do List; an `AccessibilityError` when the
  /// window itself can't be read; `failed` when the search can't finish in time.
  func check(window: AccessibilityElement, appName: String) throws {
    let deadline = clock.now + timeBudget
    var queue: [(element: AccessibilityElement, depth: Int)] = [(window, 0)]
    var visited: Set<AccessibilityElement> = [window]
    var head = 0
    while head < queue.count {
      let (element, depth) = queue[head]
      head += 1
      guard head <= maxVisited, clock.now < deadline else {
        throw ComputerError.failed(
          "Couldn't finish checking that \(appName)'s window isn't showing Daily Do List; try "
            + "again.")
      }
      let attributes: [String: AccessibilityValue]
      do {
        attributes = try api.attributes(depth == 0 ? [AX.role, AX.title] : [AX.role], of: element)
      } catch {
        if depth == 0 { throw error }
        if error == .invalidElement { continue }
        throw error.asAppError(appName: appName)
      }
      if depth == 0, let title = attributes[AX.title]?.displayString,
        targets.isWebUI(title: title)
      {
        throw ProtectedTargets.error(for: .webUI, appName: appName)
      }
      let role = attributes[AX.role]?.displayString ?? ""
      if role == AX.webArea {
        if try showsWebUI(element, appName: appName) {
          throw ProtectedTargets.error(for: .webUI, appName: appName)
        }
        continue
      }
      guard depth < maxDepth, !Self.leafRoles.contains(role) else { continue }
      let children = (try? api.children(of: element, limit: maxVisited)) ?? []
      for child in children where visited.insert(child).inserted {
        queue.append((child, depth + 1))
      }
    }
  }

  private func showsWebUI(_ webArea: AccessibilityElement, appName: String) throws -> Bool {
    let attributes: [String: AccessibilityValue]
    do {
      attributes = try api.attributes([AX.url], of: webArea)
    } catch {
      if error == .invalidElement { return false }
      throw error.asAppError(appName: appName)
    }
    switch attributes[AX.url] {
    case .url(let url): return targets.isWebUI(url: url)
    case .string(let string): return URL(string: string).map(targets.isWebUI(url:)) ?? false
    default: return false
    }
  }
}

extension AccessibilityError {
  /// The protocol error for a failure to read an app as a whole.
  func asAppError(appName: String) -> ComputerError {
    switch self {
    case .apiDisabled: .accessibilityMissing
    case .invalidElement: .stale("\(appName) changed while it was being read: read it again.")
    case .cannotComplete:
      .failed("\(appName) isn't responding to accessibility requests. Try again in a moment.")
    default: .failed("\(appName) couldn't be read through accessibility (\(self)).")
    }
  }
}
