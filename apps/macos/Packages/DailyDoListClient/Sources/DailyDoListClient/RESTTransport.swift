import DailyDoListModels
import Foundation

/// One REST exchange with the daemon: builds the request (auth, attribution, JSON body), sends it
/// through `URLSession`, and maps the answer to a value or a `DaemonClientError`.
struct RESTTransport: Sendable {
  enum Method: String, Sendable {
    case get = "GET", put = "PUT", post = "POST", delete = "DELETE"
  }

  /// Which 409 body the operation can answer.
  enum ConflictKind: Sendable {
    case none
    /// `ConflictResponse` (note write, note rename).
    case note
    /// `ApprovalConflictResponse` (approval decision).
    case approval
  }

  let endpoint: DaemonEndpoint
  let session: URLSession
  let clientId: String
  let requestTimeout: Duration
  let artifactTimeout: Duration

  /// A JSON request. Non-GET requests carry `x-ddl-client-id`; `attribute` forces it on a GET
  /// that writes (`GET /api/daily/…?create=1`).
  func json<Response: Decodable>(
    _ method: Method,
    _ path: String,
    body: (any Encodable & Sendable)? = nil,
    conflict: ConflictKind = .none,
    attribute: Bool = false,
    as type: Response.Type = Response.self
  ) async throws(DaemonClientError) -> Response {
    var data: Data?
    if let body {
      do {
        data = try JSONEncoder.daemon.encode(body)
      } catch {
        throw .invalidRequest("Could not encode the request: \(error.localizedDescription)")
      }
    }
    let request = try makeRequest(
      method, path, body: data, accept: "application/json", timeout: requestTimeout,
      attribute: attribute || method != .get)
    let (payload, response) = try await send(request)
    try check(response, payload, conflict: conflict)
    do {
      return try JSONDecoder.daemon.decode(Response.self, from: payload)
    } catch {
      throw .decoding(error, type: Response.self)
    }
  }

  /// Raw bytes and the media type (without parameters) of a binary GET.
  func bytes(_ path: String) async throws(DaemonClientError) -> ArtifactPayload {
    let request = try makeRequest(
      .get, path, body: nil, accept: "*/*", timeout: artifactTimeout, attribute: false)
    let (payload, response) = try await send(request)
    try check(response, payload, conflict: .none)
    let contentType = response.value(forHTTPHeaderField: "Content-Type") ?? ""
    let mimeType = contentType.split(separator: ";", maxSplits: 1).first
      .map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
    return ArtifactPayload(data: payload, mimeType: mimeType.isEmpty ? "application/octet-stream" : mimeType)
  }

  func makeRequest(
    _ method: Method, _ path: String, body: Data?, accept: String, timeout: Duration, attribute: Bool
  ) throws(DaemonClientError) -> URLRequest {
    guard let url = endpoint.url(forPath: path) else {
      throw .unreachable("invalid daemon URL for \(path)")
    }
    var request = URLRequest(
      url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout.seconds)
    request.httpMethod = method.rawValue
    request.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
    request.setValue(accept, forHTTPHeaderField: "Accept")
    if attribute { request.setValue(clientId, forHTTPHeaderField: DaemonProtocol.clientIdHeader) }
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return request
  }

  private func send(_ request: URLRequest) async throws(DaemonClientError) -> (Data, HTTPURLResponse) {
    if Task.isCancelled { throw .cancelled }
    let result: (Data, URLResponse)
    do {
      result = try await session.data(for: request)
    } catch {
      throw Self.transportError(error)
    }
    guard let response = result.1 as? HTTPURLResponse else {
      throw .unreachable("the daemon did not answer with HTTP")
    }
    return (result.0, response)
  }

  /// Maps a non-2xx answer to its error.
  private func check(
    _ response: HTTPURLResponse, _ payload: Data, conflict: ConflictKind
  ) throws(DaemonClientError) {
    let status = response.statusCode
    if (200..<300).contains(status) { return }
    let decoder = JSONDecoder.daemon
    switch status {
    case 401:
      throw .unauthorized
    case 409 where conflict == .note:
      // Only note conflicts carry `current`; a folder rename conflict is a plain ApiErrorBody.
      if (try? decoder.decode(ConflictProbe.self, from: payload))?.hasCurrent == true,
        let body = try? decoder.decode(ConflictResponse.self, from: payload)
      {
        throw .conflict(body)
      }
    case 409 where conflict == .approval:
      if let body = try? decoder.decode(ApprovalConflictResponse.self, from: payload) {
        throw .approvalConflict(body)
      }
    default:
      break
    }
    throw .http(status: status, body: try? decoder.decode(ApiErrorBody.self, from: payload))
  }

  static func transportError(_ error: any Error) -> DaemonClientError {
    if error is CancellationError { return .cancelled }
    if let error = error as? URLError {
      return error.code == .cancelled ? .cancelled : .unreachable(error.localizedDescription)
    }
    return .unreachable(error.localizedDescription)
  }
}

/// Whether a 409 body has a `current` key (null or a note).
private struct ConflictProbe: Decodable {
  let hasCurrent: Bool

  private enum Keys: String, CodingKey { case current }

  init(from decoder: Decoder) throws {
    hasCurrent = try decoder.container(keyedBy: Keys.self).contains(.current)
  }
}
