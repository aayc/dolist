#if os(iOS)
  import DailyDoListMobileKit
  import Foundation
  import Security
  import Testing

  @testable import DailyDoListMobileIntegration

  /// The Simulator exercises Keychain attributes and byte preservation, but omits file-protection
  /// attributes. File-class assertions below run on device; physical lock behavior also needs QA.
  @MainActor struct ProtectionNativeTests {
    @Test func migrationPreservesDataAndUpdatesDeviceOnlyCredentials() async throws {
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      let service = "test.dolist.protection." + UUID().uuidString
      let credentials = KeychainConnectionCredentials(service: service)
      let profile = UUID()
      let other = UUID()
      defer {
        SecItemDelete(
          [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
          ] as CFDictionary)
        try? FileManager.default.removeItem(at: root)
      }
      try await credentials.save("synthetic-one", for: profile)
      let migration = try PhoneProtectionMigration(rootDirectory: root, credentials: credentials)
      defer { try? migration.storage.unregister() }
      try await migration.prepare()
      let files = try MarkdownCheckpointStore(directory: root.appendingPathComponent("markdown"))
      let reference = try files.put("Synthetic offline note")
      try await migration.change(to: .whileUnlocked, quiesce: {})
      try await credentials.save("synthetic-two", for: other)
      for id in [profile, other] {
        var attributes: CFTypeRef?
        let status = SecItemCopyMatching(
          [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: id.uuidString,
            kSecReturnAttributes as String: true,
          ] as CFDictionary, &attributes)
        #expect(status == errSecSuccess)
        let value = try #require(attributes as? [String: Any])
        #expect(
          value[kSecAttrAccessible as String] as? String
            == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        #expect((value[kSecAttrSynchronizable as String] as? Bool) != true)
      }
      let newer = try files.put("A later synthetic draft")
      let scope = WorkspaceScope(
        profileID: profile, workspaceID: "synthetic-workspace", hostID: "synthetic-host",
        origin: try ConnectionOrigin("https://protection.invalid"))
      var index: SQLiteWorkspaceIndex? = try SQLiteWorkspaceIndex(
        url: root.appendingPathComponent("index.sqlite"), scope: scope)
      #expect(try index?.documents().isEmpty == true)
      #if !targetEnvironment(simulator)
        for path in [
          try files.fileURL(reference), try files.fileURL(newer),
          root.appendingPathComponent("index.sqlite"),
          root.appendingPathComponent("index.sqlite-wal"),
          root.appendingPathComponent("index.sqlite-shm"),
        ] {
          let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
          let value =
            (attributes[.protectionKey] as? FileProtectionType)?.rawValue
            ?? attributes[.protectionKey] as? String
          #expect(value == FileProtectionType.complete.rawValue)
        }
      #endif
      index = nil
      try await migration.change(to: .afterFirstUnlock, quiesce: {})
      #expect(try files.read(reference) == "Synthetic offline note")
      #expect(try files.read(newer) == "A later synthetic draft")
      #expect(try await credentials.token(for: profile) == "synthetic-one")
      #if !targetEnvironment(simulator)
        let attributes = try FileManager.default.attributesOfItem(
          atPath: files.fileURL(reference).path)
        let value =
          (attributes[.protectionKey] as? FileProtectionType)?.rawValue
          ?? attributes[.protectionKey] as? String
        #expect(value == FileProtectionType.completeUntilFirstUserAuthentication.rawValue)
      #endif
    }
  }
#endif
