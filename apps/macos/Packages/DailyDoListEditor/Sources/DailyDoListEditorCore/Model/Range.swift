import Foundation

extension NSRange {
  package func clamped(to length: Int) -> NSRange {
    let start = max(0, min(location, length))
    return NSRange(start, max(start, min(end, length)))
  }
}
