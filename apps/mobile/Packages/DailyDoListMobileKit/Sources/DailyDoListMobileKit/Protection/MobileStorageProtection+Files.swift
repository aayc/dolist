import Foundation
import SQLite3

extension MobileStorageProtectionMode {
  package var writingOptions: Data.WritingOptions {
    #if os(iOS)
      [
        .atomic,
        self == .whileUnlocked
          ? .completeFileProtection : .completeFileProtectionUntilFirstUserAuthentication,
      ]
    #else
      .atomic
    #endif
  }
  package var sqliteFlags: Int32 {
    #if os(iOS)
      self == .whileUnlocked
        ? SQLITE_OPEN_FILEPROTECTION_COMPLETE
        : SQLITE_OPEN_FILEPROTECTION_COMPLETEUNTILFIRSTUSERAUTHENTICATION
    #else
      0
    #endif
  }
  package func apply(to url: URL) throws {
    #if os(iOS)
      try FileManager.default.setAttributes(
        [
          .protectionKey: self == .whileUnlocked
            ? FileProtectionType.complete : FileProtectionType.completeUntilFirstUserAuthentication
        ],
        ofItemAtPath: url.path)
    #endif
  }
}

extension MobileStorageProtection {
  package static func createDirectory(_ directory: URL, mode: MobileStorageProtectionMode) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try mode.apply(to: directory)
  }

  /// Changes attributes in place. It never copies cleartext into a temporary weaker container,
  /// follows a symlink, removes a file, or modifies a file's contents.
  public func protectExistingFiles(_ mode: MobileStorageProtectionMode) throws {
    let manager = FileManager.default
    try manager.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
    try validate(rootDirectory)
    try mode.apply(to: rootDirectory)
    var enumerationError: Error?
    guard
      let enumerator = manager.enumerator(
        at: rootDirectory,
        includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey],
        errorHandler: { _, error in
          enumerationError = error
          return false
        })
    else { throw MobileStorageProtectionError.invalidPath }
    for case let url as URL in enumerator {
      try validate(url)
      try mode.apply(to: url)
    }
    if let enumerationError { throw enumerationError }
  }

  private func validate(_ url: URL) throws {
    let values = try url.resourceValues(forKeys: [
      .isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey,
    ])
    guard values.isSymbolicLink != true,
      values.isDirectory == true || values.isRegularFile == true
    else { throw MobileStorageProtectionError.invalidPath }
  }
}
