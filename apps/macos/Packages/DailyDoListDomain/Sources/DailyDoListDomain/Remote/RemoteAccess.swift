import Foundation

/// Validation for remote access (`remote.ts`): the names a daemon answers to besides loopback, the
/// always-on machine's address, the sync service's address, device names and pairing codes. Pure
/// string checks: nothing here resolves or connects.
///
/// URLs are read like the WHATWG parser the core uses reads them (IPv4 shorthands, default ports,
/// case), with one difference: hosts must be ASCII (the core would convert an international name to
/// punycode first), and credentials are refused even when empty.
public enum RemoteAccess {
  /// `REMOTE_LIMITS`.
  public enum Limits {
    /// Device and machine names a user enters, after trimming.
    public static let deviceNameLength = 64
    /// Names a daemon answers to besides loopback.
    public static let remoteHosts = 8
    /// A DNS name, without the port.
    public static let hostnameLength = 253
  }

  /// Pairing codes: 8 characters without look-alikes (no 0, 1, I, L, O or U).
  public static let pairingCodeAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
  public static let pairingCodeLength = 8

  // MARK: - Hosts

  /// `localhost`, `127.0.0.0/8` and `::1` (with or without brackets).
  public static func isLoopbackHostname(_ hostname: String) -> Bool {
    let host = TextTools.lowercased(hostname)
    if host == "localhost" || host == "::1" || host == "[::1]" { return true }
    let octets = host.split(separator: ".", omittingEmptySubsequences: false)
    return octets.count == 4 && octets[0] == "127"
      && octets.allSatisfy { octet in
        guard (1...3).contains(octet.count), octet.allSatisfy(\.isASCIIDigit),
          octet.count == 1 || octet.first != "0", let value = Int(octet)
        else { return false }
        return value <= 255
      }
  }

  /// `host[:port]` as a daemon's remote host (e.g. `vm-name.tailnet-name.ts.net`): trimmed and
  /// lowercased, or nil when it's not a DNS name with an optional port (IPs, schemes, paths,
  /// loopback names and trailing dots are refused).
  public static func normalizeRemoteHost(_ input: String) -> String? {
    let value = TextTools.lowercased(TextTools.trimmed(input))
    let hostname: Substring
    let port: Substring?
    if let colon = value.firstIndex(of: ":") {
      hostname = value[..<colon]
      port = value[value.index(after: colon)...]
    } else {
      hostname = value[...]
      port = nil
    }
    guard isRemoteHostname(hostname), port.map(isPort) ?? true else { return nil }
    return value
  }

  /// True for a remote host in its normalized form (what the daemon reports).
  public static func isRemoteHost(_ value: String) -> Bool {
    normalizeRemoteHost(value) == value
  }

  // MARK: - URLs

  /// The always-on machine's address as an origin, `https://<host>[:port]`, or nil. It must be
  /// https to a DNS name (plain http only to loopback, for tests) without path, query, fragment or
  /// credentials. Case and a trailing `/` are normalized away.
  public static func normalizeMachineURL(_ input: String) -> String? {
    let value = TextTools.trimmed(input)
    guard !hasControlCharacter(value), !value.contains("?"), !value.contains("#"),
      let url = ParsedURL(value), url.path.isEmpty || url.path == "/"
    else { return nil }
    let loopback = isLoopbackHostname(url.host)
    if url.scheme == "http" && !loopback { return nil }
    if !loopback && !isRemoteHostname(url.host[...]) { return nil }
    return url.origin
  }

  /// True for a machine URL in its normalized form (what settings and responses carry).
  public static func isMachineURL(_ value: String) -> Bool {
    normalizeMachineURL(value) == value
  }

  /// A service URL a token may be sent to (the sync service): https, or plain http only to
  /// loopback, without credentials. Unlike a machine URL it may carry a path.
  public static func isSecureServiceURL(_ input: String) -> Bool {
    guard !hasControlCharacter(input), let url = ParsedURL(input) else { return false }
    return url.scheme == "https" || isLoopbackHostname(url.host)
  }

  /// The default name of a machine: the first label of its host (`vm-name` for
  /// `vm-name.x.ts.net`).
  public static func defaultMachineName(_ machineURL: String) -> String {
    guard let host = ParsedURL(machineURL)?.host else { return machineURL }
    if host.hasPrefix("[") { return host }
    return host.split(separator: ".", omittingEmptySubsequences: false).first.map(String.init)
      ?? host
  }

  // MARK: - Names and codes

  /// A device or machine name a user entered: trimmed, 1–64 characters (UTF-16, like the core),
  /// no control characters.
  public static func normalizeDeviceName(_ input: String) -> String? {
    let name = TextTools.trimmed(input)
    guard !name.isEmpty, name.utf16.count <= Limits.deviceNameLength,
      !hasControlCharacter(name)
    else { return nil }
    return name
  }

  /// A sync vault or device id (`SYNC_ID_PATTERN`): 1–64 characters of `A-Z a-z 0-9 _ -`.
  public static func isSyncID(_ value: String) -> Bool {
    (1...64).contains(value.utf8.count)
      && value.utf8.allSatisfy { byte in
        (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A)
          || (byte >= 0x61 && byte <= 0x7A) || byte == 0x5F || byte == 0x2D
      }
  }

  /// A pairing code as typed (`xxxx-xxxx`, `XXXX XXXX`, `XXXXXXXX`) in its canonical form, 8
  /// uppercase characters of `pairingCodeAlphabet`, or nil.
  public static func normalizePairingCode(_ input: String) -> String? {
    let kept = input.utf16.filter { !isJSWhitespace($0) && $0 != 0x2D }
    let code = String(decoding: kept, as: UTF16.self).uppercased()
    return isPairingCode(code) ? code : nil
  }

  /// True for a pairing code in its canonical form (what the daemon issues).
  public static func isPairingCode(_ value: String) -> Bool {
    value.count == pairingCodeLength && value.allSatisfy { pairingCodeAlphabet.contains($0) }
  }

  /// How a pairing code is shown: `XXXX-XXXX`.
  public static func formatPairingCode(_ code: String) -> String {
    guard code.count == pairingCodeLength else { return code }
    let half = pairingCodeLength / 2
    return "\(code.prefix(half))-\(code.suffix(half))"
  }

  // MARK: - Helpers

  /// A DNS name another device reaches a daemon by, lowercase. IP addresses and loopback names
  /// are not remote hosts: the former are never configured, the latter always allowed.
  static func isRemoteHostname(_ hostname: Substring) -> Bool {
    guard !hostname.isEmpty, hostname.utf16.count <= Limits.hostnameLength else { return false }
    let labels = hostname.split(separator: ".", omittingEmptySubsequences: false)
    guard labels.allSatisfy(isDNSLabel) else { return false }
    // WHATWG URL parsers read a name whose last label is numeric as an IPv4 address.
    if let last = labels.last, last.allSatisfy(\.isASCIIDigit) { return false }
    return hostname != "localhost" && !hostname.hasSuffix(".localhost")
  }

  /// `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`
  private static func isDNSLabel(_ label: Substring) -> Bool {
    let bytes = Array(label.utf8)
    guard (1...63).contains(bytes.count) else { return false }
    let isAlnum = { (b: UInt8) in (b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39) }
    guard isAlnum(bytes[0]), isAlnum(bytes[bytes.count - 1]) else { return false }
    return bytes.allSatisfy { isAlnum($0) || $0 == 0x2D }
  }

  /// `^[1-9][0-9]{0,4}$`, at most 65535.
  private static func isPort(_ port: Substring) -> Bool {
    guard (1...5).contains(port.count), port.allSatisfy(\.isASCIIDigit), port.first != "0",
      let value = Int(port)
    else { return false }
    return value <= 65_535
  }

  /// `\p{Cc}`: C0 controls, DEL and C1 controls.
  static func hasControlCharacter(_ text: String) -> Bool {
    text.unicodeScalars.contains { $0.value < 0x20 || (0x7F...0x9F).contains($0.value) }
  }
}

/// An `http:` or `https:` URL, read like the WHATWG parser reads it: lowercase scheme and host,
/// IPv4 shorthands expanded, the default port dropped. Nil for anything that parser would refuse,
/// for credentials, and for hosts that aren't ASCII.
struct ParsedURL {
  let scheme: String
  let host: String
  let port: Int?
  /// Everything from the first `/` after the host (path, query and fragment), as typed.
  let path: String

  var origin: String { "\(scheme)://\(host)\(port.map { ":\($0)" } ?? "")" }

  init?(_ input: String) {
    // The parser drops leading and trailing C0 controls and spaces.
    let value = input.trimmingCharacters(in: CharacterSet(charactersIn: "\u{0}"..."\u{20}"))
    guard let separator = value.range(of: "://") else { return nil }
    let scheme = value[..<separator.lowerBound].lowercased()
    guard scheme == "http" || scheme == "https" else { return nil }
    let rest = value[separator.upperBound...]
    let authorityEnd = rest.firstIndex { "/\\?#".contains($0) } ?? rest.endIndex
    let authority = rest[..<authorityEnd]
    guard !authority.contains("@") else { return nil }

    let hostPart: Substring
    let portPart: Substring?
    if authority.hasPrefix("[") {
      guard let close = authority.firstIndex(of: "]") else { return nil }
      hostPart = authority[...close]
      let after = authority[authority.index(after: close)...]
      guard after.isEmpty || after.hasPrefix(":") else { return nil }
      portPart = after.isEmpty ? nil : after.dropFirst()
    } else if let colon = authority.firstIndex(of: ":") {
      hostPart = authority[..<colon]
      portPart = authority[authority.index(after: colon)...]
    } else {
      hostPart = authority
      portPart = nil
    }

    guard let host = Self.host(hostPart) else { return nil }
    var port: Int?
    if let portPart, !portPart.isEmpty {
      guard portPart.count <= 18, portPart.allSatisfy(\.isASCIIDigit), let value = Int(portPart),
        value <= 65_535
      else { return nil }
      port = value == (scheme == "https" ? 443 : 80) ? nil : value
    }
    self.scheme = scheme
    self.host = host
    self.port = port
    path = String(rest[authorityEnd...])
  }

  /// The host as the parser serializes it, or nil when it would refuse it.
  private static func host(_ raw: Substring) -> String? {
    guard !raw.isEmpty, raw.allSatisfy(\.isASCII) else { return nil }
    let host = raw.lowercased()
    if host.hasPrefix("[") {
      let inner = host.dropFirst().dropLast()
      guard host.hasSuffix("]"), !inner.isEmpty,
        inner.allSatisfy({ $0.isHexDigit || $0 == ":" || $0 == "." })
      else { return nil }
      return inner == "0:0:0:0:0:0:0:1" ? "[::1]" : host
    }
    guard host.allSatisfy({ $0.isLetter || $0.isNumber || "-._".contains($0) }) else { return nil }
    return endsInNumber(host) ? ipv4(host) : host
  }

  /// The WHATWG "ends in a number" check: the last label (ignoring one trailing dot) is decimal
  /// digits, or a `0x` number.
  private static func endsInNumber(_ host: String) -> Bool {
    var labels = host.split(separator: ".", omittingEmptySubsequences: false)
    if labels.last?.isEmpty == true {
      guard labels.count > 1 else { return false }
      labels.removeLast()
    }
    guard let last = labels.last, !last.isEmpty else { return false }
    if last.allSatisfy(\.isASCIIDigit) { return true }
    return ipv4Number(last) != nil
  }

  /// The WHATWG IPv4 parser: up to four parts, each decimal, `0x` hex or `0`-prefixed octal; the
  /// last part fills the remaining bytes.
  private static func ipv4(_ host: String) -> String? {
    var parts = host.split(separator: ".", omittingEmptySubsequences: false)
    if parts.last?.isEmpty == true, parts.count > 1 { parts.removeLast() }
    guard parts.count <= 4 else { return nil }
    var numbers: [UInt64] = []
    for part in parts {
      guard let number = ipv4Number(part) else { return nil }
      numbers.append(number)
    }
    guard let last = numbers.last else { return nil }
    if numbers.dropLast().contains(where: { $0 > 255 }) { return nil }
    let limit = UInt64(1) << (8 * UInt64(5 - numbers.count))
    guard last < limit else { return nil }
    var address = last
    for (index, number) in numbers.dropLast().enumerated() {
      address += number << (8 * UInt64(3 - index))
    }
    return (0..<4).map { String((address >> (8 * UInt64(3 - $0))) & 0xFF) }.joined(separator: ".")
  }

  private static func ipv4Number(_ part: Substring) -> UInt64? {
    guard !part.isEmpty else { return nil }
    var digits = part
    var radix = 10
    if part.hasPrefix("0x") || part.hasPrefix("0X") {
      digits = part.dropFirst(2)
      radix = 16
    } else if part.count >= 2, part.hasPrefix("0") {
      digits = part.dropFirst()
      radix = 8
    }
    if digits.isEmpty { return 0 }
    guard digits.count <= 16 else { return nil }
    return UInt64(digits, radix: radix)
  }
}

extension Character {
  fileprivate var isASCIIDigit: Bool { isASCII && isWholeNumber }
}
