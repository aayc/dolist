import XCTest

final class ConnectionUITests: XCTestCase {
  @MainActor
  func testEditorAcceptsRealTyping() {
    let app = XCUIApplication()
    app.launchArguments = ["--editor-spike"]
    app.launch()
    let editor = app.descendants(matching: .any)["note.editor"].firstMatch
    XCTAssertTrue(editor.waitForExistence(timeout: 10))
    editor.tap()
    editor.typeText("Typing works")
    XCTAssertTrue((editor.value as? String)?.contains("Typing works") == true)
  }

}
