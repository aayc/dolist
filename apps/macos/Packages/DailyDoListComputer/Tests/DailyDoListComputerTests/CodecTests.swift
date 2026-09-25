import Foundation
import Testing

@testable import DailyDoListComputer

@Suite("JSON values")
struct JSONValueTests {
  @Test func parsesEveryKindAndKeepsBooleansApartFromNumbers() throws {
    let value = try JSONValue.parse(
      #"{"a": true, "b": 0, "c": 1.5, "d": "x", "e": null, "f": [1, false], "g": {"h": "i"}}"#)
    let object = try #require(value.objectValue)
    #expect(object["a"] == .bool(true))
    #expect(object["b"] == .number(0))
    #expect(object["c"] == .number(1.5))
    #expect(object["d"] == .string("x"))
    #expect(object["e"] == .null)
    #expect(object["f"] == [1, false])
    #expect(object["g"] == ["h": "i"])
  }

  @Test func rejectsWhatIsNotJSON() {
    for text in ["{", "{'a': 1}", "1e400", #"{"a" 1}"#, ""] {
      #expect(throws: (any Error).self, "\(text)") { try JSONValue.parse(text) }
    }
  }

  @Test func serializesCompactlyInInsertionOrderOnOneLine() {
    let value: JSONValue = [
      "id": 3,
      "result": [
        "text": "line 1\nline 2 \"quoted\" \\ \t\u{2028}\u{01}", "n": 1.5, "whole": 12,
        "none": nil, "flags": [true, false], "empty": [:],
      ],
    ]
    #expect(
      value.serialized
        == #"{"id":3,"result":{"text":"line 1\nline 2 \"quoted\" \\ \t\u2028\u0001","n":1.5,"#
        + #""whole":12,"none":null,"flags":[true,false],"empty":{}}}"#)
    #expect(!value.serialized.contains("\n"))
  }

  @Test func serializedOutputIsValidJSONThatRoundTrips() throws {
    let value: JSONValue = [
      "emoji": "😀 é ✓", "controls": "\u{00}\u{1F}\u{7F}", "nested": [["a": [1, 2.25, -3]]],
    ]
    let text = value.serialized
    #expect(try JSONValue.parse(text) == value)
    #expect(try JSONSerialization.jsonObject(with: Data(text.utf8)) is [String: Any])
  }

  @Test func formatsNumbersTheWayJSONWants() {
    #expect(JSONValue.format(12) == "12")
    #expect(JSONValue.format(-7) == "-7")
    #expect(JSONValue.format(-0.0) == "0")
    #expect(JSONValue.format(0.25) == "0.25")
    #expect(JSONValue.format(1e20) == "1e+20")
    #expect(JSONValue.format(.infinity) == "null")
    #expect(JSONValue.format(.nan) == "null")
  }

  @Test func objectEqualityIgnoresKeyOrderButOutputKeepsIt() {
    let first: JSONObject = ["a": 1, "b": 2]
    let second: JSONObject = ["b": 2, "a": 1]
    #expect(first == second)
    #expect(JSONValue.object(first).serialized == #"{"a":1,"b":2}"#)
    #expect(JSONValue.object(second).serialized == #"{"b":2,"a":1}"#)
    var edited = first
    edited["a"] = nil
    edited["c"] = 3
    #expect(edited.keys == ["b", "c"])
  }
}

@Suite("RPC codec")
struct RPCCodecTests {
  @Test func decodesRequests() throws {
    #expect(
      try RPCCodec.decodeRequest(#"{"id": 7, "method": "snapshot", "params": {"pid": 42}}"#).get()
        == RPCRequest(id: 7, method: "snapshot", params: ["pid": 42]))
    #expect(
      try RPCCodec.decodeRequest(#"{"id":1,"method":"hello"}"#).get()
        == RPCRequest(id: 1, method: "hello"))
    #expect(
      try RPCCodec.decodeRequest(#"{"id":1,"method":"hello","params":null}"#).get().params == [:])
    #expect(
      try RPCCodec.decodeRequest(#"{"jsonrpc":"2.0","id":2,"method":"apps"}"#).get()
        == RPCRequest(id: 2, method: "apps"),
      "extra envelope keys are ignored")
  }

  @Test(
    arguments: [
      ("not json", nil),
      ("[1, 2]", nil),
      (#"{"method": "hello"}"#, nil),
      (#"{"id": "1", "method": "hello"}"#, nil),
      (#"{"id": 1}"#, 1),
      (#"{"id": 1, "method": ""}"#, 1),
      (#"{"id": 1, "method": 7}"#, 1),
      (#"{"id": 1, "method": "hello", "params": [1]}"#, 1),
      (#"{"id": 1, "method": "hello", "params": "x"}"#, 1),
    ] as [(String, Double?)])
  func rejectsLinesThatAreNotRequests(line: String, id: Double?) {
    guard case .failure(let failure) = RPCCodec.decodeRequest(line) else {
      Issue.record("accepted \(line)")
      return
    }
    #expect(failure.id == id)
    #expect(failure.error.code == .invalid)
  }

  @Test func rejectsOversizedLines() {
    let line =
      #"{"id":1,"method":"typeText","params":{"text":""#
      + String(repeating: "a", count: RPCCodec.maxRequestBytes) + #""}}"#
    guard case .failure(let failure) = RPCCodec.decodeRequest(line) else {
      Issue.record("accepted an oversized line")
      return
    }
    #expect(failure.error.code == .invalid)
  }

  @Test func encodesResults() {
    #expect(RPCCodec.encodeResult(id: 3, ["ok": true]) == #"{"id":3,"result":{"ok":true}}"#)
    #expect(
      RPCCodec.encodeResult(id: 4, ["version": 1, "pid": 99])
        == #"{"id":4,"result":{"version":1,"pid":99}}"#)
  }

  @Test func encodesEveryErrorCode() {
    #expect(
      ComputerError.Code.allCases.map(\.rawValue) == [
        "permission", "not_found", "stale", "protected", "unsupported", "invalid", "failed",
      ])
    for code in ComputerError.Code.allCases {
      #expect(
        RPCCodec.encodeError(id: 5, ComputerError(code, "Something \"happened\"."))
          == #"{"id":5,"error":{"code":""# + code.rawValue
          + #"","message":"Something \"happened\"."}}"#)
    }
    #expect(
      RPCCodec.encodeError(id: nil, .invalid("Bad line."))
        == #"{"id":null,"error":{"code":"invalid","message":"Bad line."}}"#)
  }
}

@Suite("Params")
struct ParamsTests {
  private func params(_ object: JSONObject, allowed: Set<String> = ["pid", "text", "x", "e", "s"])
    throws -> Params
  {
    try Params(method: "m", object: object, allowed: allowed)
  }

  private func code(_ work: () throws -> Void) -> ComputerError.Code? {
    do {
      try work()
      return nil
    } catch let error as ComputerError {
      return error.code
    } catch {
      return .failed
    }
  }

  @Test func rejectsUnknownParameters() {
    #expect(throws: ComputerError.invalid("m: unknown parameter \"element_id\".")) {
      try params(["element_id": "e1"])
    }
  }

  @Test func readsIntegersInRange() throws {
    #expect(try params(["pid": 42]).pid() == 42)
    #expect(try params([:]).optionalPID() == nil)
    #expect(try params(["pid": nil]).optionalPID() == nil, "null counts as absent")
    for bad: JSONValue in [42.5, 0, -1, "42", true, 3_000_000_000] {
      #expect(code { _ = try params(["pid": bad]).pid() } == .invalid, "\(bad)")
    }
    #expect(code { _ = try params([:]).pid() } == .invalid)
  }

  @Test func readsNumbersInRange() throws {
    #expect(try params(["x": 1.5]).number("x", in: 0...2) == 1.5)
    #expect(code { _ = try params(["x": 3]).number("x", in: 0...2) } == .invalid)
    #expect(code { _ = try params(["x": "1"]).number("x", in: 0...2) } == .invalid)
  }

  @Test func capsStringsInUTF16Units() throws {
    #expect(try params(["text": "hello"]).string("text", maxLength: 5) == "hello")
    #expect(code { _ = try params(["text": "hello!"]).string("text", maxLength: 5) } == .invalid)
    #expect(code { _ = try params(["text": "😀😀😀"]).string("text", maxLength: 5) } == .invalid)
    #expect(code { _ = try params(["text": ""]).string("text", maxLength: 5) } == .invalid)
    #expect(try params(["text": ""]).string("text", maxLength: 5, allowEmpty: true) == "")
    #expect(code { _ = try params(["text": 5]).string("text", maxLength: 5) } == .invalid)
  }

  @Test func readsIdentifiers() throws {
    #expect(try params(["e": "e12"]).elementID("e") == "e12")
    #expect(try params(["s": "s3"]).snapshotID("s") == "s3")
    for bad: JSONValue in ["e0", "e01", "x12", "e", "e1a", "E1", "s1", 12] {
      #expect(code { _ = try params(["e": bad]).elementID("e") } == .invalid, "\(bad)")
    }
  }

  @Test func readsChoices() throws {
    #expect(try params(["text": "left"]).choice("text", from: ["left", "right"]) == "left")
    #expect(code { _ = try params(["text": "LEFT"]).choice("text", from: ["left"]) } == .invalid)
  }
}
