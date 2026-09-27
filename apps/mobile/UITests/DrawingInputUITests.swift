import XCTest

final class DrawingInputUITests: XCTestCase {
  @MainActor
  func testTouchCreationCommitsAndUndoRestoresTheScene() {
    let app = XCUIApplication()
    app.launchArguments = ["--drawing-spike"]
    app.launch()
    let rectangle = app.buttons["Rectangle"]
    XCTAssertTrue(rectangle.waitForExistence(timeout: 10))
    rectangle.tap()
    let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.35))
    let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.6))
    start.press(forDuration: 0.1, thenDragTo: end)
    let count = app.staticTexts["drawing.count"]
    XCTAssertTrue(count.waitForExistence(timeout: 5))
    XCTAssertEqual(count.label, "Elements: 1")
    XCTAssertTrue(app.buttons["Undo"].isEnabled)
    app.buttons["Undo"].tap()
    XCTAssertEqual(count.label, "Elements: 0")
    app.buttons["Redo"].tap()
    XCTAssertEqual(count.label, "Elements: 1")
  }
}
