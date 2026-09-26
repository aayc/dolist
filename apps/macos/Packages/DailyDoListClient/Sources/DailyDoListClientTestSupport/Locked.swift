import Foundation

/// A value behind a lock, for scripted answers that change during a test (fakes are called from
/// arbitrary tasks).
public final class Locked<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value

  public init(_ value: Value) { self.value = value }

  public var current: Value { lock.withLock { value } }

  @discardableResult
  public func mutate<T>(_ body: (inout Value) -> T) -> T { lock.withLock { body(&value) } }
}
