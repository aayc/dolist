import XCTest

final class ConnectionUITests: XCTestCase {
  @MainActor
  func testEditorAcceptsRealTypingAndHardwareTab() {
    let app = XCUIApplication()
    app.launchArguments = ["--editor-spike"]
    app.launch()
    let editor = app.descendants(matching: .any)["note.editor"].firstMatch
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    editor.tap()
    editor.typeText("Typing works")
    XCTAssertTrue((editor.value as? String)?.contains("Typing works") == true)
    // The synthetic note has no tab characters; the new line is a list item either way.
    editor.typeText("\n- Tab item")
    editor.typeKey(XCUIKeyboardKey.tab.rawValue, modifierFlags: [])
    XCTAssertTrue((editor.value as? String)?.contains("\t") == true)
    editor.typeKey(XCUIKeyboardKey.tab.rawValue, modifierFlags: .shift)
    XCTAssertFalse((editor.value as? String)?.contains("\t") == true)
  }

}
