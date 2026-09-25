import Foundation

/// Test fixtures, read from the source tree (`Tests/DailyDoListDrawingTests/fixtures`).
enum Fixtures {
  static let directory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // Support
    .deletingLastPathComponent()  // DailyDoListDrawingTests
    .appendingPathComponent("fixtures", isDirectory: true)

  static func url(_ name: String) -> URL { directory.appendingPathComponent(name) }

  static func text(_ name: String) throws -> String {
    try String(contentsOf: url(name), encoding: .utf8)
  }

  static func data(_ name: String) throws -> Data {
    try Data(contentsOf: url(name))
  }

  /// Where renders and other review output go: the package's `.build/drawing-snapshots/`.
  static let snapshotDirectory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent(".build/drawing-snapshots", isDirectory: true)
}
