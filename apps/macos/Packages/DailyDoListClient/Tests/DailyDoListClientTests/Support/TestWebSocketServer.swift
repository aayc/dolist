import CryptoKit
import Foundation
import Network
import os

/// A minimal RFC 6455 server on 127.0.0.1 for tests. It parses the HTTP upgrade itself, so tests
/// can check the exact path, query and headers URLSession sends, then speaks text, binary and
/// close frames. Everything runs on one serial queue; tests observe it by polling.
final class TestWebSocketServer: @unchecked Sendable {
  struct Upgrade: Sendable {
    let method: String
    /// Request target as sent, e.g. `/ws?token=abc`.
    let target: String
    /// Header names lowercased.
    let headers: [String: String]
  }

  /// Handle on one accepted connection.
  struct Peer: Sendable {
    let id: Int
    fileprivate let server: TestWebSocketServer

    func send(_ text: String) {
      server.withConnection(id) { $0.sendFrame(opcode: 0x1, payload: Data(text.utf8)) }
    }
    func sendBinary(_ data: Data) {
      server.withConnection(id) { $0.sendFrame(opcode: 0x2, payload: data) }
    }
    /// Close handshake with `code`, then TCP close.
    func close(code: UInt16, reason: String = "") {
      server.withConnection(id) { $0.close(code: code, reason: reason) }
    }
    /// Abrupt TCP close without a close frame.
    func drop() { server.withConnection(id) { $0.drop() } }
    var messages: [String] { server.state.withLock { $0.messages[id] ?? [] } }
    var upgrade: Upgrade? { server.state.withLock { $0.upgrades[id] } }
    var isClosed: Bool { server.state.withLock { $0.closed.contains(id) } }
    var receivedCloseCode: UInt16? { server.state.withLock { $0.closeCodes[id] } }
  }

  /// What to do with a connection once upgraded (default: say hello).
  typealias OnUpgrade = @Sendable (Peer) -> Void

  static let hello = #"{"type":"hello","serverVersion":"test-1","apiVersion":1}"#

  fileprivate struct State {
    var connections: [Int: Connection] = [:]
    var upgrades: [Int: Upgrade] = [:]
    var messages: [Int: [String]] = [:]
    var closed: Set<Int> = []
    var closeCodes: [Int: UInt16] = [:]
    var nextID = 0
    var onUpgrade: OnUpgrade
    /// When set, the upgrade is refused with this HTTP status.
    var rejectStatus: Int?
  }

  let port: UInt16
  fileprivate let state: OSAllocatedUnfairLock<State>
  fileprivate let queue = DispatchQueue(label: "TestWebSocketServer")
  private let listener: NWListener

  init(onUpgrade: @escaping OnUpgrade = { $0.send(TestWebSocketServer.hello) }) async throws {
    state = OSAllocatedUnfairLock(initialState: State(onUpgrade: onUpgrade))
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    listener = try NWListener(using: parameters)
    let ready = OSAllocatedUnfairLock<UInt16?>(initialState: nil)
    listener.stateUpdateHandler = { [listener] newState in
      if case .ready = newState { ready.withLock { $0 = listener.port?.rawValue } }
    }
    let forwarder = Forwarder()
    listener.newConnectionHandler = { connection in forwarder.server?.accept(connection) }
    listener.start(queue: queue)
    port = try await waitFor("listener to be ready") { ready.withLock { $0 } }
    forwarder.server = self
  }

  /// Nobody can connect before `port` is known, so the server is attached after `init` sets it.
  private final class Forwarder: @unchecked Sendable {
    weak var server: TestWebSocketServer?
  }

  deinit { stop() }

  var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

  var peers: [Peer] {
    state.withLock { Array($0.upgrades.keys).sorted() }.map { Peer(id: $0, server: self) }
  }

  var connectionCount: Int { state.withLock { $0.upgrades.count } }

  func setOnUpgrade(_ handler: @escaping OnUpgrade) { state.withLock { $0.onUpgrade = handler } }

  func setRejectStatus(_ status: Int?) { state.withLock { $0.rejectStatus = status } }

  /// Waits for the `n`-th (1-based) upgraded connection.
  func peer(_ n: Int, timeout: Duration = .seconds(10)) async throws -> Peer {
    try await waitFor("connection #\(n)", timeout: timeout) {
      peers.count >= n ? peers[n - 1] : nil
    }
  }

  func stop() {
    listener.cancel()
    queue.async { [state] in
      for connection in state.withLock({ Array($0.connections.values) }) { connection.drop() }
    }
  }

  /// Runs `body` on the server queue with connection `id`, outside the state lock.
  fileprivate func withConnection(_ id: Int, _ body: @escaping @Sendable (Connection) -> Void) {
    queue.async { [state] in
      guard let connection = state.withLock({ $0.connections[id] }) else { return }
      body(connection)
    }
  }

  private func accept(_ nw: NWConnection) {
    let id = state.withLock { state in
      defer { state.nextID += 1 }
      return state.nextID
    }
    let connection = Connection(id: id, nw: nw, server: self)
    state.withLock { $0.connections[id] = connection }
    connection.start(on: queue)
  }

  fileprivate func upgraded(_ id: Int, _ upgrade: Upgrade) -> (Int?, OnUpgrade) {
    state.withLock { state in
      state.upgrades[id] = upgrade
      return (state.rejectStatus, state.onUpgrade)
    }
  }

  fileprivate func received(_ id: Int, _ text: String) {
    state.withLock { $0.messages[id, default: []].append(text) }
  }

  fileprivate func receivedClose(_ id: Int, code: UInt16?) {
    state.withLock { if let code { $0.closeCodes[id] = code } }
  }

  fileprivate func closed(_ id: Int) {
    state.withLock { state in
      state.closed.insert(id)
      state.connections[id] = nil
    }
  }
}

/// One TCP connection. Only touched on the server queue.
private final class Connection: @unchecked Sendable {
  let id: Int
  let nw: NWConnection
  weak var server: TestWebSocketServer?
  private var buffer = Data()
  private var upgraded = false
  private var closing = false
  private var fragments = Data()

  init(id: Int, nw: NWConnection, server: TestWebSocketServer) {
    self.id = id
    self.nw = nw
    self.server = server
  }

  func start(on queue: DispatchQueue) {
    nw.stateUpdateHandler = { [weak self] state in
      switch state {
      case .failed, .cancelled: self.map { $0.server?.closed($0.id) }
      default: break
      }
    }
    nw.start(queue: queue)
    receive()
  }

  private func receive() {
    nw.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) {
      [weak self] data, _, isComplete, error in
      guard let self else { return }
      if let data, !data.isEmpty {
        buffer.append(data)
        process()
      }
      if isComplete || error != nil {
        drop()
        return
      }
      receive()
    }
  }

  private func process() {
    if !upgraded {
      guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else { return }
      let head = String(decoding: buffer[buffer.startIndex..<end.lowerBound], as: UTF8.self)
      buffer.removeSubrange(buffer.startIndex..<end.upperBound)
      handshake(head)
    }
    while upgraded, let frame = nextFrame() { handle(frame) }
  }

  private func handshake(_ head: String) {
    var lines = head.components(separatedBy: "\r\n")
    let requestLine =
      lines.isEmpty ? [] : lines.removeFirst().split(separator: " ").map(String.init)
    var headers: [String: String] = [:]
    for line in lines {
      guard let colon = line.firstIndex(of: ":") else { continue }
      headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(
        in: .whitespaces)
    }
    let upgrade = TestWebSocketServer.Upgrade(
      method: requestLine.first ?? "", target: requestLine.count > 1 ? requestLine[1] : "",
      headers: headers)
    guard let server else { return }
    let (rejectStatus, onUpgrade) = server.upgraded(id, upgrade)
    if let status = rejectStatus {
      write("HTTP/1.1 \(status) Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n") {
        [weak self] in self?.drop()
      }
      return
    }
    let key = headers["sec-websocket-key"] ?? ""
    let accept = Data(
      Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
    )
    .base64EncodedString()
    write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
    )
    upgraded = true
    onUpgrade(TestWebSocketServer.Peer(id: id, server: server))
  }

  private struct Frame {
    let fin: Bool
    let opcode: UInt8
    let payload: Data
  }

  /// Parses one masked client frame from the buffer, if complete.
  private func nextFrame() -> Frame? {
    let bytes = [UInt8](buffer)
    guard bytes.count >= 2 else { return nil }
    let fin = bytes[0] & 0x80 != 0
    let opcode = bytes[0] & 0x0F
    let masked = bytes[1] & 0x80 != 0
    var length = Int(bytes[1] & 0x7F)
    var offset = 2
    if length == 126 {
      guard bytes.count >= 4 else { return nil }
      length = Int(bytes[2]) << 8 | Int(bytes[3])
      offset = 4
    } else if length == 127 {
      guard bytes.count >= 10 else { return nil }
      length = bytes[2..<10].reduce(0) { $0 << 8 | Int($1) }
      offset = 10
    }
    let maskLength = masked ? 4 : 0
    guard bytes.count >= offset + maskLength + length else { return nil }
    let mask = masked ? Array(bytes[offset..<offset + 4]) : [0, 0, 0, 0]
    offset += maskLength
    var payload = [UInt8](bytes[offset..<offset + length])
    for index in payload.indices { payload[index] ^= mask[index % 4] }
    buffer.removeFirst(offset + length)
    return Frame(fin: fin, opcode: opcode, payload: Data(payload))
  }

  private func handle(_ frame: Frame) {
    switch frame.opcode {
    case 0x0, 0x1:
      fragments.append(frame.payload)
      if frame.fin {
        server?.received(id, String(decoding: fragments, as: UTF8.self))
        fragments.removeAll()
      }
    case 0x8:
      let code =
        frame.payload.count >= 2 ? UInt16(frame.payload[0]) << 8 | UInt16(frame.payload[1]) : nil
      server?.receivedClose(id, code: code)
      if closing {
        drop()
      } else {
        closing = true
        sendFrame(opcode: 0x8, payload: frame.payload.prefix(2))
        drop()
      }
    case 0x9:
      sendFrame(opcode: 0xA, payload: frame.payload)
    default:
      break
    }
  }

  func sendFrame(opcode: UInt8, payload: Data) {
    var frame = Data([0x80 | opcode])
    switch payload.count {
    case ..<126: frame.append(UInt8(payload.count))
    case ..<65_536:
      frame.append(contentsOf: [126, UInt8(payload.count >> 8), UInt8(payload.count & 0xFF)])
    default:
      frame.append(127)
      frame.append(contentsOf: (0..<8).reversed().map { UInt8((payload.count >> ($0 * 8)) & 0xFF) })
    }
    frame.append(payload)
    nw.send(content: frame, completion: .contentProcessed { _ in })
  }

  func close(code: UInt16, reason: String) {
    guard !closing else { return }
    closing = true
    var payload = Data([UInt8(code >> 8), UInt8(code & 0xFF)])
    payload.append(Data(reason.utf8))
    sendFrame(opcode: 0x8, payload: payload)
    // Give the client a moment to answer the close handshake.
    nw.queue?.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.drop() }
  }

  func drop() {
    nw.cancel()
    server?.closed(id)
  }

  private func write(_ text: String, then done: (@Sendable () -> Void)? = nil) {
    nw.send(content: Data(text.utf8), completion: .contentProcessed { _ in done?() })
  }
}
