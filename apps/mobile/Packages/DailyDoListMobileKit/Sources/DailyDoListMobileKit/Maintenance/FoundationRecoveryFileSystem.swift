import Darwin
import Foundation

public struct FoundationRecoveryFileSystem: RecoveryFileSystem {
  public init() {}

  public func beginExport(in parent: URL, id: UUID) throws -> RecoveryExportLocation {
    guard parent.isFileURL else { throw WorkspaceMaintenanceError.invalidExportDestination }
    let values = try parent.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true else {
      throw WorkspaceMaintenanceError.invalidExportDestination
    }
    let destination = parent.appendingPathComponent("DailyDoList-Recovery-" + id.uuidString)
    let staging = parent.appendingPathComponent(".ddl-export-" + id.uuidString)
    guard !FileManager.default.fileExists(atPath: destination.path),
      !FileManager.default.fileExists(atPath: staging.path)
    else {
      throw WorkspaceMaintenanceError.invalidExportDestination
    }
    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false)
    do {
      for directory in ["markdown", "binary"] {
        try FileManager.default.createDirectory(
          at: staging.appendingPathComponent(directory), withIntermediateDirectories: false)
      }
    } catch {
      try? FileManager.default.removeItem(at: staging)
      throw error
    }
    return RecoveryExportLocation(staging: staging, destination: destination)
  }

  public func write(_ data: Data, relativePath: String, to location: RecoveryExportLocation) throws
  {
    // Only generated flat names enter the filesystem; original note paths are manifest data.
    let pieces = relativePath.split(separator: "/", omittingEmptySubsequences: false)
    guard
      relativePath == "manifest.json"
        || (pieces.count == 2
          && ((pieces[0] == "markdown" && pieces[1].hasSuffix(".md") && pieces[1] != ".md")
            || (pieces[0] == "binary" && pieces[1].hasSuffix(".bin") && pieces[1] != ".bin"))
          && pieces[1].utf8.allSatisfy({
            (48...57).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 46
          }))
    else {
      throw WorkspaceMaintenanceError.invalidExportDestination
    }
    let target = location.staging.appendingPathComponent(relativePath)
    guard !FileManager.default.fileExists(atPath: target.path) else {
      throw WorkspaceMaintenanceError.invalidExportDestination
    }
    try data.write(to: target, options: .atomic)
    let handle = try FileHandle(forWritingTo: target)
    defer { try? handle.close() }
    try handle.synchronize()
  }

  public func finishExport(_ location: RecoveryExportLocation) throws -> URL {
    try syncDirectory(location.staging.appendingPathComponent("markdown"))
    try syncDirectory(location.staging.appendingPathComponent("binary"))
    try syncDirectory(location.staging)
    try FileManager.default.moveItem(at: location.staging, to: location.destination)
    try syncDirectory(location.destination.deletingLastPathComponent())
    return location.destination
  }

  public func abandonExport(_ location: RecoveryExportLocation) {
    try? FileManager.default.removeItem(at: location.staging)
  }

  public func removeCheckpoints(at directory: URL) throws {
    if FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }

  private func syncDirectory(_ directory: URL) throws {
    let descriptor = Darwin.open(directory.path, O_RDONLY)
    guard descriptor >= 0 else {
      throw WorkspaceRepositoryError.storage("Cannot open recovery export folder.")
    }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else {
      throw WorkspaceRepositoryError.storage("Cannot sync recovery export folder.")
    }
  }
}
