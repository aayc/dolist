import DailyDoListDrawingModel
import Foundation
import Testing

@Suite("JSON")
struct JSONTests {
  @Test func keepsKeyOrderAndLastDuplicate() throws {
    let value = try JSONParser.parse(#"{"b": 1, "a": [true, null], "b": 2, "c": {"z": "y"}}"#)
    let object = try #require(value.objectValue)
    #expect(object.keys == ["b", "a", "c"])
    #expect(object["b"] == .number(2))
    #expect(JSONWriter.string(value, indent: "") == #"{"b":2,"a":[true,null],"c":{"z":"y"}}"#)
  }

  @Test func writesLikeJSONStringifyWithIndent() throws {
    let value = try JSONParser.parse(#"{"a": [], "b": {}, "c": [1, {"d": "e"}]}"#)
    #expect(
      JSONWriter.string(value, indent: "\t")
        == "{\n\t\"a\": [],\n\t\"b\": {},\n\t\"c\": [\n\t\t1,\n\t\t{\n\t\t\t\"d\": \"e\"\n\t\t}\n\t]\n}"
    )
  }

  @Test(
    arguments: [
      (0.0, "0"), (-0.0, "0"), (1, "1"), (-1.5, "-1.5"), (0.1, "0.1"), (1e-7, "1e-7"),
      (1.5e-7, "1.5e-7"), (0.000001, "0.000001"), (123_456_789_012, "123456789012"),
      (1e21, "1e+21"), (1.2345e22, "1.2345e+22"), (1e20, "100000000000000000000"),
      (12345678.9, "12345678.9"), (0.3490658503988659, "0.3490658503988659"), (2.5, "2.5"),
      (1_700_000_000_000, "1700000000000"), (4.35, "4.35"), (1 / 3.0, "0.3333333333333333"),
    ] as [(Double, String)])
  func formatsNumbersLikeJavaScript(value: Double, expected: String) {
    #expect(JSNumberFormat.string(value) == expected)
  }

  @Test func escapesStringsLikeJavaScript() throws {
    let text = "quote \" backslash \\ newline \n tab \t bell \u{07} emoji 🎨 slash /"
    let written = JSONWriter.string(.string(text), indent: "")
    #expect(written == #""quote \" backslash \\ newline \n tab \t bell \u0007 emoji 🎨 slash /""#)
    #expect(try JSONParser.parse(written) == .string(text))
  }

  @Test func decodesEscapesAndSurrogatePairs() throws {
    #expect(try JSONParser.parse(#""\u00e9\ud83c\udfa8\/""#) == .string("é🎨/"))
    #expect(try JSONParser.parse(#""\ud83c""#) == .string("\u{FFFD}"))
  }

  @Test(arguments: ["", "{", "[1,]", "{\"a\" 1}", "01", "1.", "tru", "\"\u{01}\"", "{} x", "-"])
  func rejectsInvalidJSON(text: String) {
    #expect(throws: JSONParseError.self) { try JSONParser.parse(text) }
  }

  @Test func roundTripsThePluginSceneByteForByte() throws {
    let text = try Fixtures.text("scene-plugin.excalidraw")
    let value = try JSONParser.parse(text)
    #expect(JSONWriter.string(value, indent: "\t") == text)
  }
}
