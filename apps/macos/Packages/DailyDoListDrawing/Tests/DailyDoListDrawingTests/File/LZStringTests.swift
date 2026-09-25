import DailyDoListDrawingModel
import Foundation
import Testing

/// LZ-String against samples compressed by the JavaScript library (fixtures/lzstring.json).
@Suite("LZ-String")
struct LZStringTests {
  @Test func matchesTheJavaScriptLibrary() throws {
    let samples = try #require(JSONParser.parse(Fixtures.text("lzstring.json")).arrayValue)
    #expect(samples.count == 6)
    for sample in samples {
      let object = try #require(sample.objectValue)
      let input = try #require(object["input"]?.stringValue)
      let base64 = try #require(object["base64"]?.stringValue)
      #expect(LZString.compressToBase64(input) == base64)
      if !input.isEmpty {
        #expect(LZString.decompressFromBase64(base64) == input)
      }
    }
    let long = String(repeating: "drawings are fun ⭐ ", count: 2_000)
    #expect(LZString.decompressFromBase64(LZString.compressToBase64(long)) == long)
    #expect(LZString.decompressFromBase64("") == nil)
  }
}
