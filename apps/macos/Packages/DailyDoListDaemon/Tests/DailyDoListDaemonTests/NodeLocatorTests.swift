import Foundation
import Testing

@testable import DailyDoListDaemon

@Suite("NodeVersion")
struct NodeVersionTests {
  @Test(arguments: [
    ("v24.4.1", NodeVersion(major: 24, minor: 4, patch: 1)),
    ("24.4.0\n", NodeVersion(major: 24, minor: 4, patch: 0)),
    ("  v25.1.0-nightly20260101abcdef \n", NodeVersion(major: 25, minor: 1, patch: 0)),
    ("v26", NodeVersion(major: 26, minor: 0, patch: 0)),
    ("v24.10", NodeVersion(major: 24, minor: 10, patch: 0)),
    ("v24.4.1+build.5", NodeVersion(major: 24, minor: 4, patch: 1)),
  ])
  func parses(_ text: String, _ expected: NodeVersion) {
    #expect(NodeVersion(parsing: text) == expected)
  }

  @Test(arguments: ["", "node", "v", "vx.1.2", "24.", "1.2.3.4", "v24.4.1abc", "zsh: command not found: node"])
  func rejects(_ text: String) {
    #expect(NodeVersion(parsing: text) == nil)
  }

  @Test func ordersNumerically() {
    #expect(NodeVersion(parsing: "v24.10.0")! > NodeVersion(parsing: "v24.9.9")!)
    #expect(NodeVersion(parsing: "v24.4.0")! >= NodeVersion.minimumSupported)
    #expect(NodeVersion(parsing: "v24.3.9")! < NodeVersion.minimumSupported)
    #expect(NodeVersion(parsing: "v22.20.0")! < NodeVersion.minimumSupported)
    #expect(NodeVersion.minimumSupported.description == "v24.4.0")
  }
}

@Suite("NodeLocator")
struct NodeLocatorTests {
  let home = URL(fileURLWithPath: "/Users/me")
  let files = FakeFileSystem()
  let commands = FakeCommandRunner()

  func locator(
    configured: String? = nil, environment: [String: String] = [:]
  ) -> NodeLocator {
    NodeLocator(
      configuredPath: configured.map { URL(fileURLWithPath: $0) },
      environment: environment, homeDirectory: home, fileSystem: files, commands: commands)
  }

  func install(_ path: String, version: String) {
    files.addExecutable(path)
    commands.setNodeVersion(version, at: path)
  }

  @Test func configuredPathWinsWithoutAnyProbing() async throws {
    install("/custom/node", version: "v24.5.0")
    install("/opt/homebrew/bin/node", version: "v25.0.0")

    let node = try await locator(configured: "/custom/node", environment: ["DDL_NODE": "/other"]).locate()

    #expect(node.url.path == "/custom/node")
    #expect(node.source == .configuration)
    #expect(!commands.calls.contains { $0.executable == "/bin/zsh" })
  }

  @Test func configuredPathThatIsTooOldIsRejectedNotReplaced() async {
    install("/custom/node", version: "v22.1.0")
    install("/opt/homebrew/bin/node", version: "v24.4.0")

    await #expect(throws: DaemonSupervisorError.configuredNodeUnusable(
      path: "/custom/node", source: "the app's configuration",
      detail: "it is v22.1.0, but v24.4.0 or newer is required")
    ) {
      try await locator(configured: "/custom/node").locate()
    }
  }

  @Test func missingConfiguredPathIsRejected() async {
    await #expect(throws: DaemonSupervisorError.configuredNodeUnusable(
      path: "~/bin/node", source: "the app's configuration",
      detail: "it doesn't exist or isn't executable")
    ) {
      try await locator(configured: "/Users/me/bin/node").locate()
    }
  }

  @Test func ddlNodeIsUsedAndTildeExpanded() async throws {
    install("/Users/me/tools/node", version: "v24.4.0")

    let node = try await locator(environment: ["DDL_NODE": "~/tools/node"]).locate()

    #expect(node.url.path == "/Users/me/tools/node")
    #expect(node.source == .environment)
  }

  @Test func brokenDdlNodeReportsTheFailure() async {
    files.addExecutable("/broken/node")
    commands.setResult(CommandResult(status: 1, standardOutput: "", standardError: "dyld: missing library"), for: "/broken/node")

    await #expect(throws: DaemonSupervisorError.configuredNodeUnusable(
      path: "/broken/node", source: "DDL_NODE",
      detail: "`node --version` failed with status 1: dyld: missing library")
    ) {
      try await locator(environment: ["DDL_NODE": "/broken/node"]).locate()
    }
  }

  @Test func loginShellComesBeforeStandardLocations() async throws {
    install("/Users/me/.local/share/mise/installs/node/24.4.1/bin/node", version: "v24.4.1")
    install("/opt/homebrew/bin/node", version: "v25.0.0")
    commands.setLoginShellOutput(
      """
      Welcome back!
      /Users/me/.local/share/mise/installs/node/24.4.1/bin/node
      \(NodeLocator.pathMarker)/Users/me/.local/share/mise/installs/node/24.4.1/bin:/usr/bin:/bin
      """)

    let node = try await locator().locate()

    #expect(node.url.path == "/Users/me/.local/share/mise/installs/node/24.4.1/bin/node")
    #expect(node.source == .loginShell)
    #expect(node.loginShellPATH == "/Users/me/.local/share/mise/installs/node/24.4.1/bin:/usr/bin:/bin")
    let shell = try #require(commands.calls.first)
    #expect(shell.executable == "/bin/zsh")
    #expect(shell.arguments.first == "-lc")
    #expect(shell.arguments.last?.hasPrefix("whence -ap node;") == true)
  }

  @Test func anOldNodeEarlierOnThePathDoesNotHideANewerOne() async throws {
    install("/usr/local/bin/node", version: "v20.19.0")
    install("/Users/me/.volta/bin/node", version: "v24.6.0")
    commands.setLoginShellOutput("/usr/local/bin/node\n/Users/me/.volta/bin/node\n\(NodeLocator.pathMarker)/usr/local/bin\n")

    let node = try await locator().locate()

    #expect(node.url.path == "/Users/me/.volta/bin/node")
    #expect(node.version == NodeVersion(major: 24, minor: 6, patch: 0))
  }

  @Test func inheritedPathIsSearchedAfterTheLoginShell() async throws {
    install("/opt/toolcache/node/24.4.1/bin/node", version: "v24.4.1")
    install("/opt/homebrew/bin/node", version: "v25.0.0")

    let node = try await locator(environment: ["PATH": "/usr/bin:/opt/toolcache/node/24.4.1/bin"]).locate()

    #expect(node.url.path == "/opt/toolcache/node/24.4.1/bin/node")
    #expect(node.source == .inheritedPath)
  }

  @Test(arguments: [
    "/opt/homebrew/bin/node", "/usr/local/bin/node", "/Users/me/.local/share/mise/shims/node",
    "/Users/me/.volta/bin/node",
  ])
  func standardLocationsAreFound(_ path: String) async throws {
    install(path, version: "v24.4.0")

    let node = try await locator().locate()

    #expect(node.url.path == path)
    #expect(node.source == .standardLocation)
  }

  @Test func standardLocationsAreTriedInOrder() async throws {
    for path in ["/usr/local/bin/node", "/Users/me/.volta/bin/node", "/opt/homebrew/bin/node"] {
      install(path, version: "v24.4.0")
    }

    #expect(try await locator().locate().url.path == "/opt/homebrew/bin/node")
  }

  @Test func nvmFallbackPicksTheNewestInstalledVersion() async throws {
    let versions = "/Users/me/.nvm/versions/node"
    files.setDirectory(versions, entries: ["v22.3.0", "v24.4.1", "v24.10.0", ".DS_Store"])
    install("\(versions)/v22.3.0/bin/node", version: "v22.3.0")
    install("\(versions)/v24.4.1/bin/node", version: "v24.4.1")
    install("\(versions)/v24.10.0/bin/node", version: "v24.10.0")

    let node = try await locator().locate()

    #expect(node.url.path == "\(versions)/v24.10.0/bin/node")
    #expect(node.source == .versionManager)
  }

  @Test func timedOutLoginShellFallsBackToStandardLocations() async throws {
    commands.setLoginShellOutput("", timedOut: true)
    install("/usr/local/bin/node", version: "v24.4.0")

    let node = try await locator().locate()

    #expect(node.url.path == "/usr/local/bin/node")
    #expect(node.loginShellPATH == nil)
  }

  @Test func onlyOldNodesListsWhatWasFound() async {
    install("/usr/local/bin/node", version: "v18.20.0")
    install("/opt/homebrew/bin/node", version: "v22.9.0")
    files.addExecutable("/Users/me/.volta/bin/node")
    commands.setResult(CommandResult(status: -1, standardOutput: "", timedOut: true), for: "/Users/me/.volta/bin/node")

    await #expect(throws: DaemonSupervisorError.nodeUnsupported(found: [
      "v22.9.0 at /opt/homebrew/bin/node",
      "v18.20.0 at /usr/local/bin/node",
      "~/.volta/bin/node (`node --version` timed out)",
    ])) {
      try await locator().locate()
    }
  }

  @Test func noNodeAtAllExplainsWhereItLooked() async throws {
    do {
      _ = try await locator().locate()
      Issue.record("expected nodeNotFound")
    } catch {
      guard case .nodeNotFound(let searched) = error else {
        Issue.record("expected nodeNotFound, got \(error)")
        return
      }
      #expect(searched.prefix(2) == ["the login shell's PATH", "the inherited PATH"])
      #expect(searched.contains("/opt/homebrew/bin/node"))
      #expect(searched.contains("~/.volta/bin/node"))
      #expect(error.message.contains("brew install node"))
    }
  }

  @Test func loginShellOutputParsing() {
    let output = """
      Last login: Mon
      node: aliased to nocorrect node
      /opt/homebrew/bin/node
      PATH=/weird:/path
      /usr/local/bin/node

      \(NodeLocator.pathMarker)/opt/homebrew/bin:/usr/bin
      /after/marker/node
      """
    let parsed = NodeLocator.parseLoginShellOutput(output)
    #expect(parsed.nodes.map(\.path) == ["/opt/homebrew/bin/node", "/usr/local/bin/node"])
    #expect(parsed.path == "/opt/homebrew/bin:/usr/bin")
  }
}
