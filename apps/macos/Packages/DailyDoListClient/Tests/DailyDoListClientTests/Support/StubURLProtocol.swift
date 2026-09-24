import DailyDoListModels
import Foundation
import os

@testable import DailyDoListClient

/// A request as the stub saw it.
struct RecordedRequest: Sendable {
  let method: String
  let url: URL
  let headers: [String: String]
  let body: Data?

  /// Raw (still percent-encoded) path, e.g. `/api/notes/Caf%C3%A9.md`.
  var path: String {
    URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
  }
  var query: String? {
    URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery
  }
  /// Path plus `?query`, exactly as sent.
  var target: String { query.map { "\(path)?\($0)" } ?? path }

  func header(_ name: String) -> String? {
    headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
  }

  var jsonBody: JSONValue? {
    body.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
  }
}

/// What the stub does with a request.
enum StubBehavior: Sendable {
  case respond(status: Int, headers: [String: String], body: Data)
  case fail(URLError)
  /// Never answers (until the task is cancelled or times out).
  case hang

  static func json(_ json: String) -> StubBehavior { .json(200, json) }

  static func json(_ status: Int, _ json: String) -> StubBehavior {
    .respond(status: status, headers: ["Content-Type": "application/json"], body: Data(json.utf8))
  }

  static func json(value: some Encodable) -> StubBehavior { .json(200, value: value) }

  static func json(_ status: Int, value: some Encodable) -> StubBehavior {
    let data = (try? JSONEncoder.daemon.encode(value)) ?? Data()
    return .respond(status: status, headers: ["Content-Type": "application/json"], body: data)
  }
}

/// One fake daemon behind a `URLProtocol`, addressed by a unique port so parallel tests don't
/// share state.
final class Stub: Sendable {
  typealias Handler = @Sendable (RecordedRequest) -> StubBehavior

  private static let registry = OSAllocatedUnfairLock<[Int: Stub]>(initialState: [:])
  private static let ports = OSAllocatedUnfairLock<Int>(initialState: 40_000)

  let port: Int
  let session: URLSession
  private let handler: OSAllocatedUnfairLock<Handler>
  private let recorded = OSAllocatedUnfairLock<[RecordedRequest]>(initialState: [])

  init(_ handler: @escaping Handler) {
    port = Self.ports.withLock { port in
      port += 1
      return port
    }
    self.handler = OSAllocatedUnfairLock(initialState: handler)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    session = URLSession(configuration: configuration)
    Self.registry.withLock { $0[port] = self }
  }

  deinit {
    let port = port
    Self.registry.withLock { _ = $0.removeValue(forKey: port) }
  }

  var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

  var requests: [RecordedRequest] { recorded.withLock { $0 } }

  func setHandler(_ handler: @escaping Handler) {
    self.handler.withLock { $0 = handler }
  }

  /// A client of this stub (token `test-token`, client id `macos_test`).
  func client(options: HTTPDaemonClient.Options = .init()) -> HTTPDaemonClient {
    HTTPDaemonClient(
      endpoint: DaemonEndpoint(baseURL: baseURL, token: "test-token"), session: session,
      clientId: "macos_test", clientVersion: "macos/test", options: options)
  }

  fileprivate static func lookup(_ port: Int?) -> Stub? {
    guard let port else { return nil }
    return registry.withLock { $0[port] }
  }

  fileprivate func handle(_ request: RecordedRequest) -> StubBehavior {
    recorded.withLock { $0.append(request) }
    return handler.withLock { $0 }(request)
  }
}

final class StubURLProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let stub = Stub.lookup(url.port) else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
      return
    }
    let recorded = RecordedRequest(
      method: request.httpMethod ?? "GET", url: url, headers: request.allHTTPHeaderFields ?? [:],
      body: request.httpBody ?? request.httpBodyStream.map(Self.read))
    switch stub.handle(recorded) {
    case .respond(let status, let headers, let body):
      guard
        let response = HTTPURLResponse(
          url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
      else { return }
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: body)
      client?.urlProtocolDidFinishLoading(self)
    case .fail(let error):
      client?.urlProtocol(self, didFailWithError: error)
    case .hang:
      break
    }
  }

  override func stopLoading() {}

  private static func read(_ stream: InputStream) -> Data {
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      guard count > 0 else { break }
      data.append(buffer, count: count)
    }
    return data
  }
}
