import Darwin

/// Loopback port helpers.
public enum LocalPort {
  public struct Failure: Error, CustomStringConvertible {
    public var description: String
  }

  /// A port on 127.0.0.1 that is free right now (the kernel picks it). Another process could take
  /// it before the daemon binds it, so use this for tests and "pick a free port" suggestions.
  public static func findFree() throws -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw Failure(description: "socket() failed: \(errno)") }
    defer { close(fd) }
    var address = loopback(port: 0)
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0 else { throw Failure(description: "bind() failed: \(errno)") }
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let named = withUnsafeMutablePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
    }
    guard named == 0 else { throw Failure(description: "getsockname() failed: \(errno)") }
    return Int(UInt16(bigEndian: address.sin_port))
  }

  private static func loopback(port: UInt16) -> sockaddr_in {
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    return address
  }
}
