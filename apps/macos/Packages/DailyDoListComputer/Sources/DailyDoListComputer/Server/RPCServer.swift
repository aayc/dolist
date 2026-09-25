import Foundation

/// One line read from stdin.
public enum InputLine: Equatable, Sendable {
  case line(String)
  /// A line longer than `RPCCodec.maxRequestBytes` (its content was dropped).
  case tooLong
}

/// Where response lines go (stdout in the helper).
public protocol ResponseWriting: Sendable {
  /// Writes one line; the writer adds the newline.
  func write(line: String)
}

/// The JSON-lines loop: requests are answered one at a time, in the order they arrive (clients
/// may pipeline them and match responses by id), and `serve` returns once the input has ended
/// and every request read has been answered.
public actor RPCServer {
  private let service: ComputerService
  private let output: any ResponseWriting
  private let log: any HelperLogging
  private let clock: any ComputerClock

  public init(
    service: ComputerService, output: any ResponseWriting, log: any HelperLogging,
    clock: any ComputerClock
  ) {
    self.service = service
    self.output = output
    self.log = log
    self.clock = clock
  }

  public func serve(_ input: AsyncStream<InputLine>) async {
    for await item in input {
      if let response = await respond(to: item) { output.write(line: response) }
    }
  }

  /// The response line for one input line; nil for a blank line.
  public func respond(to item: InputLine) async -> String? {
    let start = clock.now
    let line: String
    switch item {
    case .tooLong:
      log.handled(method: nil, duration: clock.now - start, error: .invalid)
      return RPCCodec.encodeError(id: nil, .invalid("The request line is too long."))
    case .line(let text):
      line = text
    }
    if line.allSatisfy(\.isWhitespace) { return nil }
    switch RPCCodec.decodeRequest(line) {
    case .failure(let failure):
      log.handled(method: nil, duration: clock.now - start, error: failure.error.code)
      return RPCCodec.encodeError(id: failure.id, failure.error)
    case .success(let request):
      let result = await service.call(method: request.method, params: request.params)
      let method = ComputerService.Method(rawValue: request.method)
      switch result {
      case .success(let value):
        log.handled(method: method, duration: clock.now - start, error: nil)
        return RPCCodec.encodeResult(id: request.id, value)
      case .failure(let error):
        log.handled(method: method, duration: clock.now - start, error: error.code)
        return RPCCodec.encodeError(id: request.id, error)
      }
    }
  }
}
