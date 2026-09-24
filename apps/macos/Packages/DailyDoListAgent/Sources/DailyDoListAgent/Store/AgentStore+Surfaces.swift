import AppKit
import DailyDoListModels
import Foundation

// Live surfaces (browser screencast, desktop screenshots). Frames only flow while a view is
// subscribed; subscriptions are ref-counted so several views can share one.

extension AgentStore {
  /// Frames of surfaces nobody watches are dropped beyond this many (oldest first).
  static let maxIdleFrames = 12

  /// Starts watching a surface; the daemon is told on the first subscriber.
  public func subscribe(threadId: String, surface: SurfaceKind) {
    let key = SurfaceKey(threadId: threadId, surface: surface)
    let count = subscriptionCounts[key, default: 0] + 1
    subscriptionCounts[key] = count
    if count == 1 { outbox.send(.surfaceSubscribe(threadId: threadId, surface: surface)) }
  }

  /// Stops watching a surface; the daemon is told when the last subscriber leaves. Unbalanced
  /// calls are ignored.
  public func unsubscribe(threadId: String, surface: SurfaceKind) {
    let key = SurfaceKey(threadId: threadId, surface: surface)
    guard let count = subscriptionCounts[key] else { return }
    if count > 1 {
      subscriptionCounts[key] = count - 1
    } else {
      subscriptionCounts[key] = nil
      outbox.send(.surfaceUnsubscribe(threadId: threadId, surface: surface))
    }
  }

  /// Surfaces with at least one subscriber.
  public var subscribedSurfaces: Set<SurfaceKey> { Set(subscriptionCounts.keys) }

  /// The latest frame of a surface.
  public func latestFrame(threadId: String, surface: SurfaceKind) -> SurfaceFrame? {
    frames[SurfaceKey(threadId: threadId, surface: surface)]
  }

  /// Recent actions of a surface, newest last.
  public func recentActions(threadId: String, surface: SurfaceKind) -> [SurfaceAction] {
    surfaceActions[SurfaceKey(threadId: threadId, surface: surface)] ?? []
  }

  /// The decoded image of a frame, cached until the surface's next frame.
  public func image(for frame: SurfaceFrame) -> NSImage? {
    let key = SurfaceKey(frame)
    if let cached = decodedFrames[key], cached.ts == frame.ts { return cached.image }
    guard let data = frame.imageData, let image = NSImage(data: data) else { return nil }
    decodedFrames[key] = (frame.ts, image)
    return image
  }

  func receive(_ frame: SurfaceFrame) {
    let key = SurfaceKey(frame)
    if let current = frames[key], current.ts > frame.ts || current == frame { return }
    frames[key] = frame
    if let action = frame.action {
      let log = surfaceActions[key] ?? []
      let next = SurfaceFeed.appending(SurfaceAction(action, ts: frame.ts), to: log)
      if next != log { surfaceActions[key] = next }
    }
    dropIdleFrames()
  }

  private func dropIdleFrames() {
    let idle = frames.filter { subscriptionCounts[$0.key] == nil }
    guard idle.count > Self.maxIdleFrames else { return }
    let oldest = idle.sorted { $0.value.ts < $1.value.ts }.prefix(idle.count - Self.maxIdleFrames)
    for (key, _) in oldest {
      frames[key] = nil
      surfaceActions[key] = nil
      decodedFrames[key] = nil
    }
  }
}
