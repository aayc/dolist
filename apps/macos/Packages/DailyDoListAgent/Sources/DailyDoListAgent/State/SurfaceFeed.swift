import DailyDoListModels
import Foundation

/// One live surface of one thread.
public struct SurfaceKey: Hashable, Comparable, Sendable, CustomStringConvertible {
  public var threadId: String
  public var surface: SurfaceKind

  public init(threadId: String, surface: SurfaceKind) {
    self.threadId = threadId
    self.surface = surface
  }

  public init(_ frame: SurfaceFrame) {
    self.init(threadId: frame.threadId, surface: frame.surface)
  }

  public var description: String { "\(threadId):\(surface.rawValue)" }

  public static func < (a: SurfaceKey, b: SurfaceKey) -> Bool {
    (a.threadId, a.surface.rawValue) < (b.threadId, b.surface.rawValue)
  }
}

/// An action that produced a frame (click, type, scroll…), kept for the computer action log.
public struct SurfaceAction: Hashable, Sendable, Identifiable {
  public var kind: String
  public var x: Double?
  public var y: Double?
  public var text: String?
  /// Timestamp of the frame that carried it.
  public var ts: EpochMillis

  public init(
    kind: String, x: Double? = nil, y: Double? = nil, text: String? = nil, ts: EpochMillis
  ) {
    self.kind = kind
    self.x = x
    self.y = y
    self.text = text
    self.ts = ts
  }

  public init(_ action: SurfaceFrameAction, ts: EpochMillis) {
    self.init(kind: action.kind, x: action.x, y: action.y, text: action.text, ts: ts)
  }

  public var id: String { "\(ts):\(kind):\(x ?? -1):\(y ?? -1):\(text ?? "")" }

  /// Same action, whatever frame carried it.
  func sameAction(as other: SurfaceAction) -> Bool {
    kind == other.kind && x == other.x && y == other.y && text == other.text
  }

  /// "click “Reserve” at 812, 590"
  public var summary: String {
    var out = kind
    if let text, !text.isEmpty { out += " “\(text)”" }
    if let x = Self.pixel(x), let y = Self.pixel(y) { out += " at \(x), \(y)" }
    return out
  }

  /// A coordinate from the wire as whole pixels (nil when absurd).
  private static func pixel(_ value: Double?) -> Int? {
    guard let value, value.isFinite, abs(value) < 1e9 else { return nil }
    return Int(value.rounded())
  }
}

enum SurfaceFeed {
  /// Actions kept per surface.
  static let maxActions = 40
  /// Frames are only "live" while they keep coming.
  static let liveWindow: TimeInterval = 3

  /// Appends a frame's action, skipping consecutive repeats (a stream of frames after one click).
  static func appending(_ action: SurfaceAction, to log: [SurfaceAction]) -> [SurfaceAction] {
    if let last = log.last, last.sameAction(as: action) { return log }
    return Array((log + [action]).suffix(maxActions))
  }

  static func isLive(lastFrameAt ts: EpochMillis?, now: Date) -> Bool {
    guard let ts else { return false }
    let age = now.timeIntervalSince(Date(epochMillis: ts))
    return age < liveWindow && age > -liveWindow
  }
}
