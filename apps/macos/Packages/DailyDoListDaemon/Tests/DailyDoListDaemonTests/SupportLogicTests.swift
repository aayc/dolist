import Foundation
import Testing

@testable import DailyDoListDaemon

@Suite("Launch environment")
struct DaemonProcessEnvironmentTests {
  let node = ResolvedNode(
    url: URL(fileURLWithPath: "/opt/homebrew/bin/node"), version: .minimumSupported,
    source: .loginShell, loginShellPATH: "/Users/me/.cargo/bin:/opt/homebrew/bin:/usr/bin")

  @Test func setsDaemonVariablesOverTheInheritedOnes() {
    let configuration = DaemonLaunchConfiguration(
      home: URL(fileURLWithPath: "/Users/me/.ddl"), vaultPath: URL(fileURLWithPath: "/Users/me/Vault"),
      port: 7999, agentMode: "off", extraEnvironment: ["DDL_PORT": "7999", "EXTRA": "1", "PATH": "/only"])
    let base = ["HOME": "/Users/me", "DDL_HOME": "/elsewhere", "DDL_PORT": "1234", "PATH": "/usr/bin:/bin"]

    let variables = DaemonProcessEnvironment.variables(base: base, configuration: configuration, node: node)

    #expect(variables["HOME"] == "/Users/me")
    #expect(variables["DDL_HOME"] == "/Users/me/.ddl")
    #expect(variables["DDL_VAULT"] == "/Users/me/Vault")
    #expect(variables["DDL_PORT"] == "7999")
    #expect(variables["DDL_AGENT_MODE"] == "off")
    #expect(variables["EXTRA"] == "1")
    #expect(variables["PATH"] == "/only", "extraEnvironment wins over everything")
  }

  @Test func unsetOptionsInheritTheUsersEnvironment() {
    let configuration = DaemonLaunchConfiguration(home: URL(fileURLWithPath: "/h"), port: 7331)
    let base = ["DDL_VAULT": "/Users/me/FromShell", "PATH": "/usr/bin"]

    let variables = DaemonProcessEnvironment.variables(base: base, configuration: configuration, node: node)

    #expect(variables["DDL_VAULT"] == "/Users/me/FromShell")
    #expect(variables["DDL_AGENT_MODE"] == nil)
  }

  @Test func pathStartsWithNodeThenLoginShellThenInherited() {
    #expect(
      DaemonProcessEnvironment.searchPath(
        nodeDirectory: "/opt/homebrew/bin",
        loginShellPATH: "/Users/me/.cargo/bin:/opt/homebrew/bin:/usr/bin",
        inherited: "/usr/bin:/bin:/usr/sbin:/sbin")
        == "/opt/homebrew/bin:/Users/me/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    #expect(
      DaemonProcessEnvironment.searchPath(nodeDirectory: "/n", loginShellPATH: nil, inherited: nil)
        == "/n:/usr/bin:/bin:/usr/sbin:/sbin")
  }

  @Test func watchdogPreloadIsOptional() {
    let entry = URL(fileURLWithPath: "/app/daemon/dist/main.js")
    #expect(
      DaemonProcessEnvironment.arguments(entry: entry, stopsWhenAppExits: true)
        == ["--import", DaemonProcessEnvironment.watchdogPreload, "/app/daemon/dist/main.js"])
    #expect(DaemonProcessEnvironment.arguments(entry: entry, stopsWhenAppExits: false) == ["/app/daemon/dist/main.js"])
    #expect(!DaemonProcessEnvironment.watchdogPreload.contains(" "), "one argv word, no quoting needed")
  }
}

@Suite("Restart policy")
struct DaemonRestartPolicyTests {
  @Test func backoffDoublesUpToTheCap() {
    let policy = DaemonRestartPolicy()
    #expect((1...8).map(policy.delay(forAttempt:)) == [1, 2, 4, 8, 16, 30, 30, 30].map { .seconds($0) })
    #expect(policy.delay(forAttempt: 0) == .seconds(1))
    #expect(policy.delay(forAttempt: 1_000) == .seconds(30))
  }

  @Test func customPolicy() {
    let policy = DaemonRestartPolicy(initialDelay: .milliseconds(250), maxDelay: .seconds(1), maxFailures: 0)
    #expect((1...4).map(policy.delay(forAttempt:)) == [.milliseconds(250), .milliseconds(500), .seconds(1), .seconds(1)])
    #expect(policy.maxFailures == 1)
  }

  @Test func failureHistorySlidesWithTheWindow() {
    var history = FailureHistory()
    let start = ContinuousClock.now
    let window = Duration.seconds(120)
    #expect(history.record(at: start, window: window) == 1)
    #expect(history.record(at: start + .seconds(60), window: window) == 2)
    #expect(history.record(at: start + .seconds(120), window: window) == 3)
    #expect(history.record(at: start + .seconds(121), window: window) == 3)
    #expect(history.record(at: start + .seconds(400), window: window) == 1)
    history.reset()
    #expect(history.record(at: start + .seconds(401), window: window) == 1)
  }
}

@Suite("Output lines")
struct LineSplitterTests {
  @Test func splitsAcrossChunks() {
    var splitter = LineSplitter()
    #expect(splitter.append(Data("hel".utf8)) == [])
    #expect(splitter.append(Data("lo\nwor".utf8)) == ["hello"])
    #expect(splitter.append(Data("ld\r\n\nlast".utf8)) == ["world", ""])
    #expect(splitter.flush() == ["last"])
    #expect(splitter.flush() == [])
  }

  @Test func keepsMultibyteCharactersSplitBetweenReads() {
    var splitter = LineSplitter()
    let bytes = Array("✓ ok\n".utf8)
    #expect(splitter.append(Data(bytes[0..<2])) == [])
    #expect(splitter.append(Data(bytes[2...])) == ["✓ ok"])
  }

  @Test func truncatesVeryLongLines() {
    var splitter = LineSplitter()
    let lines = splitter.append(Data((String(repeating: "x", count: 5_000) + "\n").utf8))
    #expect(lines.count == 1)
    #expect(lines[0].count == LineSplitter.maxLineLength + 1)
    #expect(lines[0].hasSuffix("…"))
  }

  @Test func runawayLinesAreEmittedInPieces() {
    var splitter = LineSplitter()
    let lines = splitter.append(Data(String(repeating: "y", count: LineSplitter.maxLineLength * 4 + 1).utf8))
    #expect(lines.count == 1)
    #expect(splitter.flush() == [])
  }

  @Test func ringBufferKeepsTheNewest() {
    var buffer = LogRingBuffer(capacity: 3)
    buffer.append(contentsOf: ["a", "b"])
    buffer.append(contentsOf: ["c", "d", "e"])
    #expect(buffer.lines == ["c", "d", "e"])
    buffer.removeAll()
    #expect(buffer.lines.isEmpty)
  }
}

@Suite("Health responses")
struct HealthClassificationTests {
  func body(_ json: String) -> Data { Data(json.utf8) }

  @Test func daemonHealthIsHealthy() {
    let result = URLSessionHealthChecker.classify(
      status: 200,
      body: body(#"{"ok":true,"version":"0.1.0","apiVersion":1,"vaultName":"Notes","agentMode":"mock"}"#),
      server: nil)
    #expect(result == .healthy(DaemonHealth(version: "0.1.0", apiVersion: 1, vaultName: "Notes", agentMode: "mock")))
  }

  @Test func daemonUnauthorizedIsRecognized() {
    let result = URLSessionHealthChecker.classify(
      status: 401, body: body(#"{"error":"unauthorized","message":"Missing or invalid bearer token"}"#),
      server: nil)
    #expect(result == .unauthorized)
  }

  @Test func anythingElseIsForeign() {
    #expect(URLSessionHealthChecker.classify(status: 404, body: body("<h1>nope</h1>"), server: "nginx") == .foreign("HTTP 404, Server: nginx"))
    #expect(URLSessionHealthChecker.classify(status: 200, body: body("hello"), server: nil) == .foreign("HTTP 200 without a health response"))
    #expect(URLSessionHealthChecker.classify(status: 401, body: body("{}"), server: nil) == .foreign("HTTP 401"))
    #expect(URLSessionHealthChecker.classify(status: 200, body: body(#"{"ok":false,"version":"1","apiVersion":1}"#), server: nil) == .foreign("HTTP 200 without a health response"))
  }
}

@Suite("Launch configuration")
struct DaemonLaunchConfigurationTests {
  let home = URL(fileURLWithPath: "/Users/me")

  @Test func defaults() {
    let configuration = DaemonLaunchConfiguration.standard(environment: [:], homeDirectory: home)
    #expect(configuration.home.path == "/Users/me/.daily-do-list")
    #expect(configuration.port == 7331)
    #expect(configuration.vaultPath == nil)
    #expect(configuration.agentMode == nil)
    #expect(configuration.manageProcess)
    #expect(configuration.stopsWhenAppExits)
    #expect(configuration.baseURL.absoluteString == "http://127.0.0.1:7331")
    #expect(configuration.tokenFile.path == "/Users/me/.daily-do-list/daemon-token")
  }

  @Test func environmentOverrides() {
    let configuration = DaemonLaunchConfiguration.standard(
      environment: ["DDL_HOME": "~/.ddl-dev", "DDL_VAULT": "~/Vault", "DDL_PORT": "7400", "DDL_AGENT_MODE": "MOCK"],
      homeDirectory: home)
    #expect(configuration.home.path == "/Users/me/.ddl-dev")
    #expect(configuration.vaultPath?.path == "/Users/me/Vault")
    #expect(configuration.port == 7400)
    #expect(configuration.agentMode == "mock")
  }

  @Test func portFromTheDaemonConfigFile() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ddl-config-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try Data(#"{"port": 7612, "agentMode": "off"}"#.utf8).write(to: directory.appendingPathComponent("config.json"))

    let fromFile = DaemonLaunchConfiguration.standard(environment: ["DDL_HOME": directory.path], homeDirectory: home)
    let fromEnvironment = DaemonLaunchConfiguration.standard(
      environment: ["DDL_HOME": directory.path, "DDL_PORT": "7613"], homeDirectory: home)

    #expect(fromFile.port == 7612)
    #expect(fromEnvironment.port == 7613, "env beats config.json, like the daemon")

    try Data(#"{"port": 0}"#.utf8).write(to: directory.appendingPathComponent("config.json"))
    #expect(DaemonLaunchConfiguration.standard(environment: ["DDL_HOME": directory.path], homeDirectory: home).port == 7331)
  }

  @Test func errorMessagesAbbreviateTheHomeFolder() {
    #expect(displayPath("/Users/me/.daily-do-list/daemon-token", homeDirectory: "/Users/me") == "~/.daily-do-list/daemon-token")
    #expect(displayPath("/Users/me", homeDirectory: "/Users/me") == "~")
    #expect(displayPath("/Users/me2", homeDirectory: "/Users/me") == "/Users/me2")
    #expect(displayPath("/Users/you/x", homeDirectory: "/Users/me") == "/Users/you/x")
  }
}
