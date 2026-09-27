import Foundation

/// A dispatch receipt. `applied` preserves the original HTTP result, including a rejection or
/// accepted asynchronous action; it does not claim the agent finished its work.
public struct AgentOperationResponse: Codable, Sendable, Hashable {
  public enum Outcome: String, Codable, Sendable { case applied, pending, indeterminate }
  public struct Response: Codable, Sendable, Hashable {
    public var status: Int
    public var body: JSONValue

    public init(status: Int, body: JSONValue) {
      self.status = status
      self.body = body
    }
  }

  public var operationId: String
  public var workspaceId: String
  public var outcome: Outcome
  public var response: Response?

  public init(operationId: String, workspaceId: String, outcome: Outcome, response: Response? = nil)
  {
    self.operationId = operationId
    self.workspaceId = workspaceId
    self.outcome = outcome
    self.response = response
  }

  private enum CodingKeys: String, CodingKey { case operationId, workspaceId, outcome, response }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    operationId = try values.decode(String.self, forKey: .operationId)
    workspaceId = try values.decode(String.self, forKey: .workspaceId)
    outcome = try values.decode(Outcome.self, forKey: .outcome)
    response = try values.decodeIfPresent(Response.self, forKey: .response)
    if outcome == .applied && response == nil {
      throw DecodingError.keyNotFound(
        CodingKeys.response,
        .init(
          codingPath: decoder.codingPath,
          debugDescription: "An applied operation requires its response."))
    }
  }
}
