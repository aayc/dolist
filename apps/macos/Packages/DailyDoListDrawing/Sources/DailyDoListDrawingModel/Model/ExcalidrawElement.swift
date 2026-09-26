import Foundation

/// One Excalidraw element (`@excalidraw/element`'s schema, 0.18): the fields every element has,
/// the text, linear and freehand fields, and everything else kept verbatim in ``preserved``.
///
/// Elements of any type round-trip; rectangles, ellipses, diamonds, arrows, lines, freehand
/// strokes and text are drawn and edited in full, images and frames are drawn as placeholders.
public struct ExcalidrawElement: Hashable, Sendable, Identifiable {
  public var id: String
  public var type: ElementType
  public var x: Double = 0
  public var y: Double = 0
  public var width: Double = 0
  public var height: Double = 0
  /// Radians, clockwise, around the element's center.
  public var angle: Double = 0
  public var strokeColor: String = "#1e1e1e"
  public var backgroundColor: String = "transparent"
  public var fillStyle: FillStyle = .solid
  public var strokeWidth: Double = 2
  public var strokeStyle: StrokeStyle = .solid
  /// Sloppiness: 0 architect, 1 artist, 2 cartoonist.
  public var roughness: Double = 1
  /// 0…100.
  public var opacity: Double = 100
  public var groupIds: [String] = []
  public var frameId: String?
  /// Fractional index (rocicorp/fractional-indexing) ordering elements for merges.
  public var index: String?
  public var roundness: Roundness?
  /// Seeds the hand-drawn strokes, so they look the same on every render.
  public var seed: Int = 1
  /// Incremented on every change (merges keep the higher version).
  public var version: Int = 1
  /// Random on every change (breaks ties between equal versions).
  public var versionNonce: Int = 0
  public var isDeleted: Bool = false
  public var boundElements: [BoundElement]?
  /// Epoch milliseconds of the last change.
  public var updated: Int = 1
  public var link: String?
  public var locked: Bool = false

  /// Set for `text` elements.
  public var text: TextProperties?

  /// Relative to `x`/`y`; lines, arrows and freehand strokes.
  public var points: [DrawingPoint] = []
  public var lastCommittedPoint: DrawingPoint?
  public var startBinding: PointBinding?
  public var endBinding: PointBinding?
  public var startArrowhead: Arrowhead?
  public var endArrowhead: Arrowhead?
  public var elbowed: Bool = false
  /// Freehand pen pressures, one per point (empty with simulated pressure).
  public var pressures: [Double] = []
  public var simulatePressure: Bool = true
  /// A frame's title.
  public var name: String?

  /// Fields this engine doesn't model and where each field was, so writing the element back
  /// keeps it as it was read.
  public internal(set) var preserved = PreservedFields()

  public init(id: String, type: ElementType) {
    self.id = id
    self.type = type
  }

  /// A field this engine doesn't model (an image's `fileId`, `customData`, the Obsidian plugin's
  /// `rawText`…).
  public func extraField(_ key: String) -> JSONValue? { preserved.extra[key] }

  /// Sets or removes an unmodeled field.
  public mutating func setExtraField(_ key: String, _ value: JSONValue?) {
    preserved.extra[key] = value
    if value != nil, !preserved.keyOrder.contains(key) { preserved.keyOrder.append(key) }
  }

  public var isLinear: Bool { type.isLinear }

  /// The id of the text label bound to this element.
  public var boundTextId: String? {
    boundElements?.first { $0.type == "text" }?.id
  }

  public var containerId: String? { text?.containerId }

  /// The frame's name, or an image's file id, for descriptions.
  public var fileId: String? { preserved.extra["fileId"]?.stringValue }
}

/// What an element carries beyond its modeled fields.
public struct PreservedFields: Hashable, Sendable {
  /// Every key the element was read with, in order (modeled and not).
  public var keyOrder: [String] = []
  /// Values of keys this engine doesn't model, and of modeled keys whose value it couldn't read.
  public var extra = JSONObject()
  /// Modeled keys whose source value differs from what the model writes when unchanged: absent
  /// keys (nil) and values it couldn't read or that read lossily. Written back verbatim while the
  /// modeled value still encodes to `unchanged`.
  var fallbacks: [String: Fallback] = [:]
  /// Whether the element was read from a file (new elements write every field).
  var wasRead = false

  struct Fallback: Hashable, Sendable {
    var raw: JSONValue?
    var unchanged: JSONValue
  }

  public init() {}
}
