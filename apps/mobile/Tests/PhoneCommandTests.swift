import DailyDoListMobileKit
import DailyDoListModels
import Foundation
import Testing
import UIKit

@testable import DailyDoList

@MainActor struct PhoneCommandTests {
  @Test func restoredPaletteUsesDownloadedNamesAndPathsAndResetsKeyboardSelection() async throws {
    let fixture = try CommandFixture()
    defer { fixture.remove() }
    let workspace = fixture.workspace
    _ = try await workspace.repository.create(path: "Projects/Plan.md", content: "Synthetic words")
    _ = try await workspace.repository.create(path: "Planning/Other.md", content: "Other")
    workspace.tabs.place("Planning/Other.md")
    workspace.tabs.place("Projects/Plan.md")
    let controller = PhoneCommandController(workspace: workspace)
    let model = PhonePaletteModel(mode: .notes, controller: controller, debounce: {})
    await model.refresh()
    #expect(model.items.first?.id == "Planning/Other.md")
    model.move(-1)
    #expect(model.selectedIndex == 1)
    model.query = "plan"
    #expect(model.selectedIndex == 0)
    #expect(model.items.first?.id == "Projects/Plan.md")
    #expect(model.items.count == 2)
    model.mode = .contents
    model.query = "Synthetic"
    await model.searchContents()
    #expect(model.items.count == 1)
    #expect(model.items.first?.title == "Projects/Plan.md")
    #expect(model.coverage.contains("Downloaded"))
  }

  @Test func commandsRecheckAuthorityAfterPaletteDismissalAndNeverDispatchAStalePathForm()
    async throws
  {
    let fixture = try CommandFixture()
    defer { fixture.remove() }
    var current = true
    let controller = PhoneCommandController(workspace: fixture.workspace, isCurrent: { current })
    controller.presentation = .palette(.commands)
    #expect(controller.run(.newNote))
    #expect(controller.awaitingDismissal)
    current = false
    controller.dismissed()
    #expect(controller.presentation == nil)
    #expect(!controller.run(.today))
    current = true
    #expect(!controller.canRun(.rename))
    #expect(!controller.canRun(.newFolder))
    #expect(controller.run(.newNote))
    let epoch = fixture.workspace.generation
    fixture.workspace.invalidateAuthority()
    controller.completePath(.note, original: "", path: "Late.md", epoch: epoch)
    controller.dismissed()
    #expect(try await fixture.workspace.repository.note("Late.md") == nil)
  }

  @Test func paletteFormattingUsesTheOriginalNoteSelectionAndDoesNotAffectAnotherSection()
    async throws
  {
    let fixture = try CommandFixture()
    defer { fixture.remove() }
    let note = try await fixture.workspace.repository.create(path: "Draft.md", content: "word")
    fixture.workspace.show(note)
    let controller = PhoneCommandController(workspace: fixture.workspace)
    let editor = try #require(fixture.workspace.active?.editor)
    editor.selection = NSRange(location: 0, length: 4)
    controller.presentation = .palette(.commands)
    #expect(controller.run(.bold))
    #expect(editor.text == "word")
    controller.dismissed()
    #expect(editor.text == "**word**")
    fixture.workspace.selectedTab = 2
    #expect(!controller.run(.italic))
    #expect(editor.text == "**word**")
    await fixture.workspace.checkpointAll()
  }

  @Test func paletteKeyboardLeavesMarkedTextNavigationToTheInputMethod() {
    let input = PaletteInput()
    var keys: [PhonePaletteKey] = []
    input.onKey = { keys.append($0) }
    input.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    let down = UIKeyCommand(
      input: UIKeyCommand.inputDownArrow, modifierFlags: [],
      action: #selector(PaletteInput.navigate(_:)))
    input.navigate(down)
    #expect(keys.isEmpty)
    input.unmarkText()
    input.navigate(down)
    let create = UIKeyCommand(
      input: "\r", modifierFlags: [.command, .shift], action: #selector(PaletteInput.navigate(_:)))
    input.navigate(create)
    #expect(keys == [.move(1), .submit(newTab: true, create: true)])
  }

  @Test func catalogCoversEachPhoneCommandAndDoesNotAssignCollidingShortcuts() {
    #expect(Set(PhoneCommand.all.map(\.id)) == Set(PhoneCommandID.allCases))
    #expect(Set(PhoneCommand.all.map(\.id)).count == PhoneCommand.all.count)
    let shortcuts = PhoneCommand.all.compactMap(\.shortcut)
    #expect(Set(shortcuts).count == shortcuts.count)
  }
}

@MainActor private struct CommandFixture {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let workspace: PhoneWorkspace
  init() throws {
    var profile = ConnectionProfile(
      name: "Synthetic host", origin: try ConnectionOrigin("https://notes.example.test"))
    profile.workspaceID = "workspace"
    profile.hostID = "host"
    let scope = WorkspaceScope(
      profileID: profile.id, workspaceID: "workspace", hostID: "host", origin: profile.origin)
    workspace = try PhoneWorkspace(
      rootDirectory: root,
      structural: try WorkspaceStructuralCoordinator(rootDirectory: root, scope: scope),
      recovery: try WorkspaceRecovery(rootDirectory: root, scope: scope), profile: profile,
      repository: try WorkspaceRepository(rootDirectory: root, scope: scope),
      drawingRepository: try DrawingRepository(rootDirectory: root, scope: scope),
      cache: try WorkspaceCache(rootDirectory: root, scope: scope),
      captureOutbox: try CaptureOutbox(rootDirectory: root, scope: scope))
  }
  func remove() { try? FileManager.default.removeItem(at: root) }
}
