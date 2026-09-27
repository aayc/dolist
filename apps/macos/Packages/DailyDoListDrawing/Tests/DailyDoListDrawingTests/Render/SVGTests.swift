import CoreGraphics
import Foundation
import Testing

@testable import DailyDoListDrawingCore

@Suite("Bounded static drawing SVG")
struct SVGTests {
  @Test func decodesShapesTransformsClippingAndOpacityLocally() throws {
    let source = """
      <svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80">
        <defs><clipPath id="clip"><rect width="50" height="80"/></clipPath></defs>
        <g clip-path="url(#clip)" transform="translate(10 10)">
          <path d="M0 0H60V40H0Z" fill="#ff0000"/>
          <path d="M10 10q10 -10 20 0t20 0" fill="none" stroke="black"/>
        </g>
      </svg>
      """
    let image = try #require(StaticSVGImage.decode(Data(source.utf8)))
    #expect(image.width == 100 && image.height == 80)
    #expect(EmbeddedDrawingImages.decode(Data(source.utf8)) != nil)
    let bytes = try #require(image.dataProvider?.data) as Data
    let alpha = bytes[(30 * image.bytesPerRow) + 20 * 4 + 3]
    let outside = bytes[(30 * image.bytesPerRow) + 80 * 4 + 3]
    #expect(alpha == 255 && outside == 0)
    let transform = try #require(StaticSVGPath.transform("translate(10 20) scale(2)"))
    #expect(CGPoint(x: 2, y: 3).applying(transform) == CGPoint(x: 14, y: 26))
    #expect(StaticSVGPath.decode("M0 0C1 2 3 4 5 6S7 8 9 10Q11 12 13 14T15 16Z") != nil)
  }

  @Test func rejectsActiveExternalUnboundedAndUnsupportedSVGWithoutPartialRender() {
    let bodies = [
      "<script>alert(1)</script>", "<image href='https://example.invalid/image.png'/>",
      "<use href='file:///synthetic.svg'/>", "<foreignObject/>",
      "<rect width='20' height='20' filter='url(#filter)'/>",
      "<path d='M0 0A10 10 0 0 0 20 20'/>",
      "<g transform='scale(1e999)'><rect width='20' height='20'/></g>",
      "<rect width='20' height='20' fill='url(https://example.invalid/pattern)'/>",
    ]
    for body in bodies {
      #expect(StaticSVGImage.decode(Data("<svg width='40' height='40'>\(body)</svg>".utf8)) == nil)
    }
    #expect(
      StaticSVGImage.decode(
        Data("<!DOCTYPE svg [<!ENTITY test SYSTEM 'file:///synthetic'>]><svg>&test;</svg>".utf8))
        == nil)
    #expect(StaticSVGImage.decode(Data("<svg width='1e999' height='40'/>".utf8)) == nil)
    #expect(StaticSVGImage.decode(Data(repeating: 32, count: 2_000_001)) == nil)
  }

  @Test func exportRetainsVectorGeometryAndGlyphsWithoutActiveContent() throws {
    var shape = TestScenes.element(.rectangle, id: "shape", x: 10, y: 10, width: 80, height: 40)
    shape.link = "javascript:alert('synthetic')"
    shape.strokeColor = "#ff0000"
    var text = TestScenes.element(.text, id: "label", x: 20, y: 20, width: 100, height: 25)
    text.text = .init(text: "<script>synthetic</script>")
    let scene = ExcalidrawScene(elements: [shape, text])
    let svg = try DrawingSVG.render(scene)
    #expect(svg.contains("<path") && svg.contains("rgb(255,0,0)"))
    #expect(!svg.contains("<script>") && !svg.contains("javascript:") && !svg.contains("<image"))
    #expect(StaticSVGImage.decode(Data(svg.utf8)) != nil)
  }
  @MainActor
  @Test func svgImageBytesSurviveInsertionAndCopyExportsOnlyLocalImageData() throws {
    let data = Data(
      "<svg width='40' height='20'><rect width='40' height='20' fill='blue'/></svg>".utf8)
    let editor = DrawingEditor(scene: .init(), environment: DeterministicDrawingEnvironment())
    let id = try editor.insertImage(data: data, mimeType: "image/svg+xml", at: .zero)
    let file = try #require(editor.element(id)?.fileId)
    let url = try #require(
      editor.scene.files.objectValue?[file]?.objectValue?["dataURL"]?.stringValue)
    #expect(EmbeddedDrawingImages.data(from: url) == data)
    let exported = try DrawingSVG.render(editor.scene)
    #expect(exported.contains("data:image/png;base64,"))
    #expect(StaticSVGImage.decode(Data(exported.utf8)) != nil)
  }

}
