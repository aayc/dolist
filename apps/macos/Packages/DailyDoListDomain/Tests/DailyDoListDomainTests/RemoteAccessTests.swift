import DailyDoListDomain
import Testing

/// The cases of `packages/core/src/remote.test.ts`, plus what the URL parser does to hosts.
extension DomainTests {
  struct RemoteAccessTests {
    @Test(arguments: ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"])
    func loopbackHostnames(_ host: String) {
      #expect(RemoteAccess.isLoopbackHostname(host))
    }

    @Test(arguments: [
      "localhost.example.com", "128.0.0.1", "127.0.0.256", "127.0.0.01", "127.0.0", "0.0.0.0",
      "[::2]", "vm-name.tailnet-name.ts.net", "",
    ])
    func notLoopbackHostnames(_ host: String) {
      #expect(!RemoteAccess.isLoopbackHostname(host))
    }

    @Test(arguments: [
      ("vm-name.tailnet-name.ts.net", "vm-name.tailnet-name.ts.net"),
      ("  VM-Name.Tailnet-Name.TS.net ", "vm-name.tailnet-name.ts.net"),
      ("vm-name.tailnet-name.ts.net:8443", "vm-name.tailnet-name.ts.net:8443"),
      ("vm-name", "vm-name"),
      ("xn--caf-dma.example", "xn--caf-dma.example"),
      ("a.b:65535", "a.b:65535"),
    ])
    func acceptsRemoteHosts(_ input: String, _ expected: String) {
      #expect(RemoteAccess.normalizeRemoteHost(input) == expected)
      #expect(RemoteAccess.isRemoteHost(expected))
    }

    @Test(arguments: [
      "", "https://vm-name.tailnet-name.ts.net", "vm-name.tailnet-name.ts.net/app", "100.64.0.1",
      "100.64.0.1:443", "vm.123", "[fd7a:115c:a1e0::1]", "localhost", "app.localhost",
      "vm-name.ts.net.", "vm..ts.net", "-vm.ts.net", "vm_name.ts.net",
      String(repeating: "a", count: 64) + ".ts.net", String(repeating: "a.", count: 126) + "ab",
      "vm.ts.net:0", "vm.ts.net:65536", "vm.ts.net:0443", "vm.ts.net:", "user@vm.ts.net",
      "vm name.ts.net", "café.example",
    ])
    func refusesRemoteHosts(_ input: String) {
      #expect(RemoteAccess.normalizeRemoteHost(input) == nil)
      #expect(!RemoteAccess.isRemoteHost(input))
    }

    @Test func reportsOnlyNormalizedHostsAsRemoteHosts() {
      #expect(!RemoteAccess.isRemoteHost("VM.ts.net"))
      #expect(!RemoteAccess.isRemoteHost(" vm.ts.net"))
    }

    @Test(arguments: [
      ("https://vm-name.tailnet-name.ts.net", "https://vm-name.tailnet-name.ts.net"),
      ("https://vm-name.tailnet-name.ts.net/", "https://vm-name.tailnet-name.ts.net"),
      (" HTTPS://VM-Name.Tailnet-Name.ts.net:8443 ", "https://vm-name.tailnet-name.ts.net:8443"),
      ("https://vm-name.tailnet-name.ts.net:443", "https://vm-name.tailnet-name.ts.net"),
      ("http://127.0.0.1:7400", "http://127.0.0.1:7400"),
      ("http://localhost:7400/", "http://localhost:7400"),
      ("http://[::1]:7400", "http://[::1]:7400"),
      ("https://127.0.0.1:8443", "https://127.0.0.1:8443"),
      // The URL parser's readings of IPv4 shorthands and ports.
      ("http://127.1:7400", "http://127.0.0.1:7400"),
      ("http://127.0.0.01:80", "http://127.0.0.1"),
      ("https://vm.ts.net:08443", "https://vm.ts.net:8443"),
    ])
    func acceptsMachineURLs(_ input: String, _ expected: String) {
      #expect(RemoteAccess.normalizeMachineURL(input) == expected)
      #expect(RemoteAccess.isMachineURL(expected))
    }

    @Test(arguments: [
      "http://vm-name.tailnet-name.ts.net", "ftp://vm-name.tailnet-name.ts.net",
      "vm-name.tailnet-name.ts.net", "https://vm-name.tailnet-name.ts.net/api",
      "https://vm-name.tailnet-name.ts.net/?a=1", "https://vm-name.tailnet-name.ts.net?",
      "https://vm-name.tailnet-name.ts.net#x", "https://user:secret@vm-name.tailnet-name.ts.net",
      "https://user@vm-name.tailnet-name.ts.net", "https://100.64.0.1", "https://1.2.3",
      "https://vm_name.ts.net", "https://vm-name\n.tailnet-name.ts.net",
      "https://vm-name.tailnet\t-name.ts.net", "https://", "",
      // Beyond the core's cases.
      "https://vm.ts.net:65536", "https://vm.ts.net:x", "http://[::2]:7400",
    ])
    func refusesMachineURLs(_ input: String) {
      #expect(RemoteAccess.normalizeMachineURL(input) == nil)
    }

    @Test func reportsOnlyNormalizedURLsAsMachineURLs() {
      #expect(!RemoteAccess.isMachineURL("https://vm-name.tailnet-name.ts.net/"))
      #expect(!RemoteAccess.isMachineURL("https://VM.ts.net"))
    }

    @Test func namesAMachineAfterTheFirstLabelOfItsHost() {
      #expect(
        RemoteAccess.defaultMachineName("https://vm-name.tailnet-name.ts.net:8443") == "vm-name")
      #expect(RemoteAccess.defaultMachineName("http://localhost:7400") == "localhost")
      #expect(RemoteAccess.defaultMachineName("http://[::1]:7400") == "[::1]")
    }

    @Test(arguments: [
      "https://sync.example.com", "https://sync.example.com/prefix", "http://127.0.0.1:7332",
      "http://localhost:7332", "http://[::1]:7332",
    ])
    func acceptsSecureServiceURLs(_ url: String) {
      #expect(RemoteAccess.isSecureServiceURL(url))
    }

    @Test(arguments: [
      "http://sync.example.com", "https://user:secret@sync.example.com", "ftp://sync.example.com",
      "sync.example.com", "https://sync.example.com\n", "",
    ])
    func refusesServiceURLs(_ url: String) {
      #expect(!RemoteAccess.isSecureServiceURL(url))
    }

    @Test func trimsAndKeepsDeviceNamesOf1To64Characters() {
      #expect(RemoteAccess.normalizeDeviceName("  Work laptop ") == "Work laptop")
      #expect(
        RemoteAccess.normalizeDeviceName(String(repeating: "x", count: 64))?.count
          == RemoteAccess.Limits.deviceNameLength)
      #expect(RemoteAccess.normalizeDeviceName("Café ☕") == "Café ☕")
    }

    @Test(arguments: ["", "   ", String(repeating: "x", count: 65), "tab\tname", "line\nbreak"])
    func refusesDeviceNames(_ name: String) {
      #expect(RemoteAccess.normalizeDeviceName(name) == nil)
    }

    @Test func pairingCodesUse8CharactersWithoutLookAlikes() {
      let alphabet = RemoteAccess.pairingCodeAlphabet
      #expect(!alphabet.contains { "01ILOU".contains($0) })
      #expect(Set(alphabet).count == alphabet.count)
      #expect(RemoteAccess.pairingCodeLength == 8)
    }

    @Test(arguments: [
      ("ABCD2345", "ABCD2345"), ("abcd-2345", "ABCD2345"), (" ABCD 2345 ", "ABCD2345"),
      ("abcd2345", "ABCD2345"),
    ])
    func normalizesPairingCodes(_ input: String, _ expected: String) {
      #expect(RemoteAccess.normalizePairingCode(input) == expected)
      #expect(RemoteAccess.isPairingCode(expected))
    }

    @Test(arguments: ["", "ABCD234", "ABCD23456", "ABCD-O123", "ABCD_2345", "ABCDÉ234"])
    func refusesPairingCodes(_ input: String) {
      #expect(RemoteAccess.normalizePairingCode(input) == nil)
    }

    @Test func reportsOnlyCanonicalCodesAsPairingCodes() {
      #expect(!RemoteAccess.isPairingCode("abcd2345"))
      #expect(!RemoteAccess.isPairingCode("ABCD-2345"))
    }

    @Test func showsACodeAsXXXXDashXXXX() {
      #expect(RemoteAccess.formatPairingCode("ABCD2345") == "ABCD-2345")
      #expect(RemoteAccess.formatPairingCode("ABC") == "ABC")
    }

    @Test func syncIDsAre1To64URLSafeCharacters() {
      #expect(RemoteAccess.isSyncID("vault_1-A"))
      #expect(RemoteAccess.isSyncID(String(repeating: "v", count: 64)))
      #expect(!RemoteAccess.isSyncID(""))
      #expect(!RemoteAccess.isSyncID(String(repeating: "v", count: 65)))
      #expect(!RemoteAccess.isSyncID("vault 1"))
      #expect(!RemoteAccess.isSyncID("välja"))
    }
  }
}
