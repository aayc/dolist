import Foundation

/// Where new ids, seeds, nonces and timestamps come from: the system in the app, a seeded
/// sequence in tests.
public protocol DrawingEnvironment: AnyObject, Sendable {
  /// Epoch milliseconds.
  func now() -> Int
  /// A random integer in 0..<2^31 (Excalidraw's `randomInteger`).
  func randomInteger() -> Int
  /// A new element id: 8 characters from [0-9a-zA-Z], as the Obsidian plugin makes them (it
  /// reads `## Text Elements` references as exactly 8 characters and re-ids longer ones).
  func randomId() -> String
}

/// The clock and the system's random numbers.
public final class SystemDrawingEnvironment: DrawingEnvironment {
  public init() {}

  public func now() -> Int { Int((Date().timeIntervalSince1970 * 1000).rounded()) }
  public func randomInteger() -> Int { Int.random(in: 0..<(1 << 31)) }

  public func randomId() -> String {
    var generator = SystemRandomNumberGenerator()
    return ElementID.make(using: &generator)
  }
}

/// A repeatable environment for tests: ids `id0`, `id1`…, a fixed clock that the test advances,
/// and a seeded random sequence.
public final class DeterministicDrawingEnvironment: DrawingEnvironment, @unchecked Sendable {
  private let lock = NSLock()
  private var clock: Int
  private var state: UInt64
  private var nextId = 0

  public init(now: Int = 1_700_000_000_000, seed: UInt64 = 42) {
    self.clock = now
    self.state = seed
  }

  public func advance(milliseconds: Int) {
    lock.withLock { clock += milliseconds }
  }

  public func now() -> Int { lock.withLock { clock } }

  public func randomInteger() -> Int {
    lock.withLock {
      // SplitMix64.
      state &+= 0x9E37_79B9_7F4A_7C15
      var z = state
      z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
      z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
      z ^= z >> 31
      return Int(z >> 33)
    }
  }

  public func randomId() -> String {
    lock.withLock {
      defer { nextId += 1 }
      return "id\(nextId)"
    }
  }
}

/// Element ids like `newDrawingElementId` in `@ddl/core` (Obsidian block references allow no `_`).
enum ElementID {
  static let alphabet = Array("1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")

  static func make(using generator: inout some RandomNumberGenerator, length: Int = 8) -> String {
    String(
      (0..<length).map { _ in alphabet[Int.random(in: 0..<alphabet.count, using: &generator)] })
  }
}

extension ExcalidrawElement {
  /// Marks a change the way Excalidraw's `mutateElement` does: a higher `version`, a new
  /// `versionNonce` and `updated` now, so merges with the web app's edits prefer this one.
  public mutating func bumpVersion(in environment: DrawingEnvironment) {
    version += 1
    versionNonce = environment.randomInteger()
    updated = environment.now()
  }
}
