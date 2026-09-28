import DailyDoListMobileDrawing
import Darwin
import Foundation

/// The device's shape library as one file in the app's managed storage root. A save renames a
/// synced, protected temporary file over the old one and then syncs the folder entry, so the file
/// always holds either the previous library or the new one.
struct PhoneDrawingLibraryFile {
  /// One storage access interval: the protection class new bytes get, held until `end` runs.
  struct Access {
    var protection: FileProtectionType
    var end: () -> Void = {}
  }
  let url: URL
  /// Storage protection grants each read and write; it may refuse while protected data is
  /// unavailable or a protection change is migrating files.
  var beginAccess: () throws -> Access

  init(
    rootDirectory: URL,
    beginAccess: @escaping () throws -> Access = {
      Access(protection: .completeUntilFirstUserAuthentication)
    }
  ) {
    url = rootDirectory.appendingPathComponent("drawing-library.excalidrawlib")
    self.beginAccess = beginAccess
  }

  var storage: MobileDrawingLibrary.Storage {
    MobileDrawingLibrary.Storage(load: read, save: write)
  }

  func read() throws -> Data? {
    let access = try beginAccess()
    defer { access.end() }
    do { return try Data(contentsOf: url) } catch CocoaError.fileReadNoSuchFile { return nil }
  }

  func write(_ data: Data) throws {
    let access = try beginAccess()
    defer { access.end() }
    let manager = FileManager.default
    let directory = url.deletingLastPathComponent()
    try manager.createDirectory(at: directory, withIntermediateDirectories: true)
    let temporary = directory.appendingPathComponent(
      ".\(url.lastPathComponent).\(UUID().uuidString)")
    guard
      manager.createFile(
        atPath: temporary.path, contents: nil, attributes: [.protectionKey: access.protection])
    else { throw CocoaError(.fileWriteUnknown) }
    do {
      let handle = try FileHandle(forWritingTo: temporary)
      defer { try? handle.close() }
      try handle.write(contentsOf: data)
      try handle.synchronize()
      guard Darwin.rename(temporary.path, url.path) == 0 else {
        throw CocoaError(.fileWriteUnknown)
      }
    } catch {
      try? manager.removeItem(at: temporary)
      throw error
    }
    let folder = Darwin.open(directory.path, O_RDONLY)
    guard folder >= 0 else { throw CocoaError(.fileWriteUnknown) }
    defer { Darwin.close(folder) }
    guard Darwin.fsync(folder) == 0 else { throw CocoaError(.fileWriteUnknown) }
  }
}
