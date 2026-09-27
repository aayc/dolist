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

  @MainActor
  func testInlineTouchDrawingDoesNotScrollOrEditTheEnclosingNote() {
    let app = XCUIApplication()
    app.launchArguments = ["--drawing-spike", "--inline-drawing-spike"]
    app.launch()
    let menu = app.buttons["Embed actions"].firstMatch
    XCTAssertTrue(menu.waitForExistence(timeout: 10))
    menu.tap()
    app.buttons["Edit here"].tap()
    let rectangle = app.buttons["Rectangle"].firstMatch
    XCTAssertTrue(rectangle.waitForExistence(timeout: 5))
    rectangle.tap()
    let canvas = app.descendants(matching: .any)["DrawingCanvasSurface"].firstMatch
    XCTAssertTrue(canvas.waitForExistence(timeout: 5))
    let scrollBefore = app.staticTexts["drawing.note-scroll"].label
    let start = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.25))
    let end = canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.7))
    start.press(forDuration: 0.1, thenDragTo: end)
    let count = app.staticTexts["drawing.count"]
    XCTAssertEqual(count.label, "Elements: 1")
    XCTAssertEqual(app.staticTexts["drawing.note-source"].label, "Note unchanged")
    XCTAssertEqual(app.staticTexts["drawing.note-scroll"].label, scrollBefore)
    app.buttons["Undo"].tap()
    XCTAssertEqual(count.label, "Elements: 0")
    app.buttons["Redo"].tap()
    XCTAssertEqual(count.label, "Elements: 1")
    menu.tap()
    app.buttons["Done editing"].tap()
    XCTAssertFalse(rectangle.exists)
    menu.tap()
    app.buttons["Edit here"].tap()
    XCTAssertTrue(rectangle.waitForExistence(timeout: 5))
    XCTAssertEqual(count.label, "Elements: 1")
    XCTAssertEqual(app.staticTexts["drawing.note-source"].label, "Note unchanged")
  }

}
