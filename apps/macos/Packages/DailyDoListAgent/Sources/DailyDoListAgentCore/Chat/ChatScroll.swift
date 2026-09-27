import Foundation

/// Whether the chat follows new content, and how many messages arrived while the user read
/// further up.
///
/// At the bottom, growing content (new messages, text typing out, a taller chat bar) keeps the
/// bottom in view. Any scroll away from it stops that, so nothing ever pulls a reader down, not
/// even rows above resizing as they load. Within `pinThreshold` of the bottom still counts as at
/// the bottom for the "Jump to latest" pill and its count. Growth and scrolling are told apart by
/// what changed: the content's or viewport's height (growth), or only the offset (a scroll).
package struct ChatScroll: Equatable, Sendable {
  package init() {}

  /// Within this distance of the bottom, the pill hides and new messages count as seen.
  package static let pinThreshold: CGFloat = 48
  /// Within this distance, the chat is at the bottom and follows growth.
  package static let followTolerance: CGFloat = 2

  package private(set) var isPinned = true
  /// Messages that arrived while unpinned.
  package private(set) var unseen = 0
  /// At the bottom, or on the way there: growth scrolls down.
  package private(set) var isFollowing = true
  /// Scrolling down to the latest message (the pill stays hidden on the way).
  package private(set) var isJumping = false
  private var contentHeight: CGFloat?
  private var viewportHeight: CGFloat?
  private var lastDistance: CGFloat = 0

  /// The layout changed. Returns whether to scroll to the bottom.
  /// - Parameter distanceFromBottom: from the viewport's bottom edge down to the content's.
  package mutating func layoutChanged(
    contentHeight: CGFloat, viewportHeight: CGFloat, distanceFromBottom: CGFloat
  ) -> Bool {
    let resized = contentHeight != self.contentHeight || viewportHeight != self.viewportHeight
    self.contentHeight = contentHeight
    self.viewportHeight = viewportHeight
    defer { lastDistance = distanceFromBottom }
    if resized, isFollowing { return distanceFromBottom > 0.5 }
    if !resized, isJumping {
      if distanceFromBottom <= Self.followTolerance {
        isJumping = false
      } else if distanceFromBottom <= lastDistance {
        return false
      } else {
        // The user scrolled away mid-jump.
        isJumping = false
      }
    }
    if !resized { isFollowing = distanceFromBottom <= Self.followTolerance }
    setPinned(distanceFromBottom <= Self.pinThreshold)
    return false
  }

  /// `count` messages arrived.
  package mutating func arrived(_ count: Int) {
    if !isPinned, count > 0 { unseen += count }
  }

  /// The user asked for the latest message: the chat scrolls down to it.
  package mutating func jumpToLatest() {
    setPinned(true)
    isFollowing = true
    isJumping = true
  }

  private mutating func setPinned(_ pinned: Bool) {
    isPinned = pinned
    if pinned { unseen = 0 }
  }
}
