import XCTest

final class ConnectionUITests: XCTestCase {
  @MainActor
  func testInvalidAddressRemainsOnConnectionScreen() {
    let app = XCUIApplication()
    app.launch()
    app.buttons["Connect a host"].tap()
    let address = app.textFields["connection.address"]
    XCTAssertTrue(address.waitForExistence(timeout: 10))
    address.tap()
    address.typeText("http://notes.example.test")
    app.buttons["connection.validate"].tap()
    XCTAssertTrue(app.staticTexts["connection.message"].exists)
    XCTAssertTrue(address.exists)
  }
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
