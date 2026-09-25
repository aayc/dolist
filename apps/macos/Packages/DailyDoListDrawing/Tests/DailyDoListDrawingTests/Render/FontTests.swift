import CoreText
import DailyDoListDrawingModel
import Foundation
import Testing

@testable import DailyDoListDrawing

@Suite("Fonts")
struct FontTests {
  @Test func excalifontIsBundledWithItsLicense() throws {
    #expect(DrawingFonts.hasExcalifont)
    let font = DrawingFonts.font(family: FontFamily.excalifont, size: 20)
    #expect(CTFontCopyPostScriptName(font) as String == "Excalifont-Regular")
    // Excalidraw's FONT_METADATA for Excalifont: 886 / -374 per 1000 units.
    #expect(abs(CTFontGetAscent(font) - 17.72) < 0.01)
    #expect(abs(CTFontGetDescent(font) - 7.48) < 0.01)
    let license = try #require(DrawingFonts.resourceURL("Excalifont-OFL.txt"))
    let text = try String(contentsOf: license, encoding: .utf8)
    #expect(text.contains("SIL OPEN FONT LICENSE Version 1.1"))
  }

  @Test func handDrawnFamiliesUseExcalifontAndTheRestSystemFonts() {
    for family in [FontFamily.virgil, FontFamily.excalifont, FontFamily.local, 42] {
      #expect(
        CTFontCopyPostScriptName(DrawingFonts.font(family: family, size: 16)) as String
          == "Excalifont-Regular")
    }
    #expect(
      CTFontCopyFamilyName(DrawingFonts.font(family: FontFamily.helvetica, size: 16)) as String
        == "Helvetica")
    #expect(
      CTFontCopyFamilyName(DrawingFonts.font(family: FontFamily.cascadia, size: 16)) as String
        == "Menlo")
  }

  @Test func textIsMeasuredAndWrappedLikeExcalidraw() {
    let size = TextLayout.measure(
      "Hello\n\nworld", fontSize: 20, fontFamily: FontFamily.excalifont, lineHeight: 1.25)
    #expect(size.height == 75)
    #expect(size.width > 40 && size.width < 70)
    let wrapped = TextLayout.wrap(
      "The quick brown fox jumps over the lazy dog", fontSize: 20,
      fontFamily: FontFamily.excalifont, maxWidth: 120)
    let lines = wrapped.split(separator: "\n")
    #expect(lines.count > 2)
    for line in lines {
      #expect(
        TextLayout.lineWidth(String(line), fontSize: 20, fontFamily: FontFamily.excalifont) <= 120)
    }
    #expect(
      TextLayout.wrap(
        "Supercalifragilistic", fontSize: 20, fontFamily: FontFamily.excalifont, maxWidth: 60
      )
      .split(separator: "\n").count > 2, "long words break between characters")
  }

  @Test func firstBaselineFollowsTheFamilysMetrics() {
    let layout = TextLayout(
      text: "A", fontSize: 20, fontFamily: FontFamily.excalifont, lineHeight: 1.25)
    // getVerticalOffset: 20/1000 × 886 + (25 − 17.72 − 7.48) / 2.
    #expect(abs(layout.verticalOffset - 17.62) < 1e-9)
  }
}
