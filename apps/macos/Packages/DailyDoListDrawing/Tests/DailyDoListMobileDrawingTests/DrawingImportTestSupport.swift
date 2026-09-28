import CoreGraphics
import Foundation
import ImageIO
import Testing

/// A photo provider the test finishes explicitly. Like real providers, it ignores cancellation.
final class ControlledImageLoad: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Data?, any Error>?
  private var result: Result<Data?, any Error>?

  var bytes: @Sendable () async throws -> Data? {
    { [self] in
      try await withCheckedThrowingContinuation { continuation in
        lock.withLock {
          if let result {
            continuation.resume(with: result)
          } else {
            self.continuation = continuation
          }
        }
      }
    }
  }

  func finish(_ result: Result<Data?, any Error>) {
    lock.withLock {
      if let continuation {
        continuation.resume(with: result)
        self.continuation = nil
      } else {
        self.result = result
      }
    }
  }
}

enum SyntheticPNG {
  static func data() throws -> Data {
    let context = try #require(
      CGContext(
        data: nil, width: 8, height: 4, bitsPerComponent: 8, bytesPerRow: 32,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 8, height: 4))
    let bytes = NSMutableData()
    let destination = try #require(
      CGImageDestinationCreateWithData(bytes, "public.png" as CFString, 1, nil))
    CGImageDestinationAddImage(destination, try #require(context.makeImage()), nil)
    #expect(CGImageDestinationFinalize(destination))
    return bytes as Data
  }
}
