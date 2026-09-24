import Foundation
import Testing

@testable import DailyDoListDaemon

@Suite("DaemonEntryLocator")
struct DaemonEntryLocatorTests {
  let files = FakeFileSystem()
  let repo = "/Users/me/src/daily-do-list"
  let resources = URL(fileURLWithPath: "/Applications/Daily Do List.app/Contents/Resources")

  func locator(
    configured: String? = nil,
    environment: [String: String] = [:],
    bundle: URL? = nil,
    executable: String? = nil,
    currentDirectory: String = "/"
  ) -> DaemonEntryLocator {
    DaemonEntryLocator(
      configuredEntry: configured.map { URL(fileURLWithPath: $0) },
      environment: environment,
      bundleResourceURL: bundle,
      executableURL: executable.map { URL(fileURLWithPath: $0) },
      currentDirectory: URL(fileURLWithPath: currentDirectory),
      homeDirectory: URL(fileURLWithPath: "/Users/me"),
      fileSystem: files)
  }

  @Test func configuredEntryIsUsed() throws {
    files.addFile("/srv/daemon/dist/main.js")
    files.addFile("\(repo)/apps/daemon/dist/main.js")

    let entry = try locator(configured: "/srv/daemon/dist/main.js", currentDirectory: repo).locate()

    #expect(entry.entry.path == "/srv/daemon/dist/main.js")
    #expect(entry.source == .configuration)
    #expect(entry.packageDirectory.path == "/srv/daemon")
  }

  @Test func missingConfiguredEntryIsAnError() {
    files.addFile("\(repo)/apps/daemon/dist/main.js")
    #expect(throws: DaemonSupervisorError.configuredEntryMissing(
      path: "~/gone/main.js", source: "the app's configuration")
    ) {
      try locator(configured: "/Users/me/gone/main.js", currentDirectory: repo).locate()
    }
  }

  @Test func environmentEntryIsUsedAndStrict() throws {
    files.addFile("/Users/me/daemon/dist/main.js")
    let entry = try locator(environment: ["DDL_DAEMON_ENTRY": "~/daemon/dist/main.js"]).locate()
    #expect(entry.entry.path == "/Users/me/daemon/dist/main.js")
    #expect(entry.source == .environment)

    #expect(throws: DaemonSupervisorError.configuredEntryMissing(path: "/nope.js", source: "DDL_DAEMON_ENTRY")) {
      try locator(environment: ["DDL_DAEMON_ENTRY": "/nope.js"]).locate()
    }
  }

  @Test func bundledDaemonComesBeforeTheRepository() throws {
    files.addFile(resources.appendingPathComponent("daemon/dist/main.js").path)
    files.addFile("\(repo)/apps/daemon/dist/main.js")

    let entry = try locator(bundle: resources, currentDirectory: repo).locate()

    #expect(entry.source == .appBundle)
    #expect(entry.packageDirectory.path == resources.appendingPathComponent("daemon").path)
  }

  @Test func repoRootFromTheEnvironment() throws {
    files.addFile("\(repo)/apps/daemon/dist/main.js")

    let entry = try locator(environment: ["DDL_REPO_ROOT": repo], bundle: resources).locate()

    #expect(entry.entry.path == "\(repo)/apps/daemon/dist/main.js")
    #expect(entry.source == .repository)
    #expect(entry.packageDirectory.path == "\(repo)/apps/daemon")
  }

  @Test func walksUpFromTheExecutable() throws {
    files.addFile("\(repo)/apps/daemon/dist/main.js")

    let fromSwiftRun = try locator(executable: "\(repo)/apps/macos/.build/arm64-apple-macosx/debug/DailyDoList").locate()
    let fromBuiltApp = try locator(
      bundle: URL(fileURLWithPath: "\(repo)/apps/macos/build/Daily Do List.app/Contents/Resources"),
      executable: "\(repo)/apps/macos/build/Daily Do List.app/Contents/MacOS/DailyDoList"
    ).locate()

    #expect(fromSwiftRun.entry.path == "\(repo)/apps/daemon/dist/main.js")
    #expect(fromBuiltApp.entry.path == "\(repo)/apps/daemon/dist/main.js")
  }

  @Test func walksUpFromTheCurrentDirectory() throws {
    files.addFile("\(repo)/apps/daemon/dist/main.js")

    let entry = try locator(executable: "/usr/local/bin/tool", currentDirectory: "\(repo)/apps/macos").locate()

    #expect(entry.entry.path == "\(repo)/apps/daemon/dist/main.js")
  }

  @Test func notFoundListsTheSearch() {
    do {
      _ = try locator(bundle: resources, executable: "/Applications/X.app/Contents/MacOS/X").locate()
      Issue.record("expected an error")
    } catch {
      guard case .daemonEntryNotFound(let searched) = error else {
        Issue.record("unexpected \(error)")
        return
      }
      #expect(searched.first == "/Applications/Daily Do List.app/Contents/Resources/daemon/dist/main.js")
      #expect(searched.contains("parents of the app's executable"))
      #expect(searched.contains("parents of the current directory"))
    }
  }
}
