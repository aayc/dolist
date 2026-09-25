import Foundation

/// One request line: `{"id": <number>, "method": "<name>", "params": {…}}`.
public struct RPCRequest: Sendable, Equatable {
  public var id: Double
  public var method: String
  public var params: JSONObject

  public init(id: Double, method: String, params: JSONObject = [:]) {
    self.id = id
    self.method = method
    self.params = params
  }
}

/// A line that isn't a usable request, with its id when one could be read (else the response
/// carries `"id": null`).
public struct RPCRequestFailure: Error, Equatable, Sendable {
  public var id: Double?
  public var error: ComputerError
}

/// The JSON-lines envelope: one request per line in, one response per line out.
public enum RPCCodec {
  /// Longest request line accepted; real requests are a few hundred bytes (text caps at 10,000).
  public static let maxRequestBytes = 1 << 20
  static let maxMethodLength = 64

  public static func decodeRequest(_ line: String) -> Result<RPCRequest, RPCRequestFailure> {
    guard line.utf8.count <= maxRequestBytes else {
      return .failure(RPCRequestFailure(id: nil, error: .invalid("The request line is too long.")))
    }
    guard let value = try? JSONValue.parse(line), case .object(let envelope) = value else {
      return .failure(
        RPCRequestFailure(id: nil, error: .invalid("A request must be one JSON object per line.")))
    }
    guard case .number(let id) = envelope["id"], id.isFinite else {
      return .failure(
        RPCRequestFailure(id: nil, error: .invalid("A request needs a numeric \"id\".")))
    }
    guard case .string(let method) = envelope["method"], !method.isEmpty,
      method.count <= maxMethodLength
    else {
      return .failure(
        RPCRequestFailure(id: id, error: .invalid("A request needs a \"method\" string.")))
    }
    switch envelope["params"] {
    case nil, .null:
      return .success(RPCRequest(id: id, method: method))
    case .object(let params):
      return .success(RPCRequest(id: id, method: method, params: params))
    default:
      return .failure(
        RPCRequestFailure(id: id, error: .invalid("\"params\" must be an object.")))
    }
  }

  public static func encodeResult(id: Double, _ result: JSONValue) -> String {
    JSONValue.object(["id": .number(id), "result": result]).serialized
  }

  public static func encodeError(id: Double?, _ error: ComputerError) -> String {
    JSONValue.object(["id": id.map { .number($0) } ?? .null, "error": error.json]).serialized
  }
}
