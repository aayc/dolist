import CoreGraphics
import Foundation

/// `CGWindowListCopyWindowInfo`. It needs no permission as long as titles aren't read.
public struct LiveWindowList: WindowListing {
  public init() {}

  public func onScreenWindows() -> [WindowInfo] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
      return []
    }
    return list.compactMap { entry in
      guard let number = entry[kCGWindowNumber as String] as? NSNumber,
        let owner = entry[kCGWindowOwnerPID as String] as? NSNumber,
        let bounds = entry[kCGWindowBounds as String] as? NSDictionary,
        let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary)
      else { return nil }
      return WindowInfo(
        id: number.uint32Value, pid: owner.int32Value, frame: Rect(frame),
        layer: (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
        alpha: (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
    }
  }
}
