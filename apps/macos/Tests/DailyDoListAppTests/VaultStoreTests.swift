import DailyDoListClient
import DailyDoListDomain
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

@MainActor
@Suite("VaultStore")
struct VaultStoreTests {
  let client = FakeDaemonClient(
    notes: [
      "Daily/2026-09-22.md": "", "Daily/2026-09-23.md": "", "Projects/Launch/Plan.md": "",
      "Ideas.md": "", "Day 10.md": "", "Day 2.md": "", ".obsidian/app.json": "{}",
    ],
    folders: ["Empty"])

  private func loadedStore() async throws -> VaultStore {
    let vault = VaultStore(client: client)
    vault.setTree(try await client.tree())
    return vault
  }

  @Test func treeHasFoldersFirstNaturalOrderAndImpliedFolders() async throws {
    let vault = try await loadedStore()
    #expect(vault.tree.map(\.name) == ["Daily", "Empty", "Projects", "Day 2", "Day 10", "Ideas"])
    let projects = try #require(vault.tree.first { $0.name == "Projects" })
    #expect(projects.children.map(\.path) == ["Projects/Launch"])
    #expect(vault.isFolder("Projects/Launch"), "folders implied by file paths exist")
    #expect(!vault.has(".obsidian/app.json"), "hidden paths are skipped")
    #expect(vault.files == ["Daily/2026-09-22.md", "Daily/2026-09-23.md", "Day 10.md", "Day 2.md", "Ideas.md", "Projects/Launch/Plan.md"])
  }

  @Test func visibleRowsFollowExpansion() async throws {
    let vault = try await loadedStore()
    let collapsed = VaultTree.visibleRows(vault.tree, expanded: [])
    #expect(collapsed.count == 6)
    let expanded = VaultTree.visibleRows(vault.tree, expanded: ["Projects", "Projects/Launch"])
    #expect(expanded.map(\.path).contains("Projects/Launch/Plan.md"))
    #expect(expanded.first { $0.path == "Projects/Launch/Plan.md" }?.depth == 2)
  }

  @Test func createNoteIsOptimisticAndRolledBackOnFailure() async throws {
    let vault = try await loadedStore()
    client.fail("writeNote", with: .http(status: 500, body: nil))
    await #expect(throws: DaemonClientError.self) {
      _ = try await vault.createNote("New.md")
    }
    #expect(!vault.has("New.md"))
    client.fail("writeNote", with: nil)
    _ = try await vault.createNote("New.md", content: "hi")
    #expect(vault.isFile("New.md"))
    #expect(client.note("New.md")?.content == "hi")
  }

  @Test func createOnlyConflictKeepsTheEntry() async throws {
    let vault = try await loadedStore()
    await #expect(throws: DaemonClientError.self) {
      _ = try await vault.createNote("Ideas.md")
    }
    #expect(vault.isFile("Ideas.md"))
  }

  @Test func renameMovesFolderContentsAndRollsBack() async throws {
    let vault = try await loadedStore()
    _ = try await vault.rename(from: "Projects", to: "Archive")
    #expect(vault.isFile("Archive/Launch/Plan.md"))
    #expect(!vault.has("Projects"))

    client.fail("rename", with: .http(status: 500, body: nil))
    await #expect(throws: DaemonClientError.self) {
      _ = try await vault.rename(from: "Ideas.md", to: "Deep/Nested/Ideas.md")
    }
    #expect(vault.isFile("Ideas.md"))
    #expect(!vault.has("Deep"), "folders implied by the failed target are removed again")
  }

  @Test func deleteIsSoftAndRestoredOnFailure() async throws {
    let vault = try await loadedStore()
    client.fail("deleteFolder", with: .unreachable("offline"))
    await #expect(throws: DaemonClientError.self) {
      _ = try await vault.delete("Daily")
    }
    #expect(vault.isFile("Daily/2026-09-23.md"))
    client.fail("deleteFolder", with: nil)
    let trash = try await vault.delete("Daily")
    #expect(trash.trashedTo.hasPrefix(".trash/"))
    #expect(!vault.has("Daily/2026-09-23.md"))
  }

  @Test func refreshKeepsNotesTheSnapshotMayPredate() async throws {
    let vault = try await loadedStore()
    vault.setTree(VaultTreeResponse(vaultName: "Test Vault", entries: []), keeping: [("Just Created.md", "v1")])
    #expect(vault.isFile("Just Created.md"))
    #expect(vault.files == ["Just Created.md"])
  }
}
