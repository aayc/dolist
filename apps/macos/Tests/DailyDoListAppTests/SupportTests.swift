import DailyDoListClient
import DailyDoListDomain
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

@MainActor
@Suite("Scheduler & timers")
struct TimerTests {
  @Test func manualSchedulerRunsDueActionsInOrder() {
    let scheduler = ManualScheduler()
    var log: [String] = []
    scheduler.schedule(after: 0.2) { log.append("b") }
    scheduler.schedule(after: 0.1) { log.append("a") }
    let cancelled = scheduler.schedule(after: 0.15) { log.append("x") }
    cancelled.cancel()
    scheduler.schedule(after: 0.1) {
      log.append("a2")
      scheduler.schedule(after: 0.05) { log.append("nested") }
    }
    scheduler.advance(by: 0.3)
    #expect(log == ["a", "a2", "nested", "b"])
    #expect(scheduler.pendingCount == 0)
  }

  @Test func idleTimerFiresOnceAfterTheLastPoke() {
    let scheduler = ManualScheduler()
    var fired = 0
    let timer = IdleTimer(scheduler: scheduler, delay: 0.3) { fired += 1 }
    timer.poke()
    scheduler.advance(by: 0.2)
    timer.poke()
    scheduler.advance(by: 0.2)
    #expect(fired == 0)
    scheduler.advance(by: 0.1)
    #expect(fired == 1)
    scheduler.advance(by: 1)
    #expect(fired == 1)
  }

  @Test func throttleIsLeadingAndTrailing() {
    let scheduler = ManualScheduler()
    var sent: [Int] = []
    let throttle = Throttle<Int>(scheduler: scheduler, interval: 0.4) { sent.append($0) }
    throttle.call(1)
    throttle.call(2)
    throttle.call(3)
    #expect(sent == [1])
    scheduler.advance(by: 0.4)
    #expect(sent == [1, 3])
    scheduler.advance(by: 1)
    throttle.call(4)
    #expect(sent == [1, 3, 4])
  }
}

@Suite("Paths & names")
struct NotePathsTests {
  @Test func namesAreValidatedLikeObsidian() {
    #expect(NotePaths.validateName("Groceries") == nil)
    #expect(NotePaths.validateName("  ") != nil)
    #expect(NotePaths.validateName(".hidden") != nil)
    #expect(NotePaths.validateName("a/b") != nil)
    #expect(NotePaths.validateName("what?") != nil)
    #expect(NotePaths.validateName("[[x]]") != nil)
  }

  @Test func wikiLinkTargetDropsHeadingAndAlias() {
    #expect(NotePaths.wikiLinkTarget("Plan#Goals|the plan") == "Plan")
    #expect(NotePaths.wikiLinkTarget(" Daily/2026-09-23 ") == "Daily/2026-09-23")
  }

  @Test func helpers() {
    #expect(NotePaths.renamed("Projects/a.md", from: "Projects", to: "Work") == "Work/a.md")
    #expect(NotePaths.renamed("Projects2/a.md", from: "Projects", to: "Work") == nil)
    #expect(
      NotePaths.uniquePath(folder: "F", base: "Untitled") {
        ["F/Untitled.md", "F/Untitled 1.md"].contains($0)
      } == "F/Untitled 2.md")
    #expect(NotePaths.displayName("a/Plan.md", isFolder: false) == "Plan")
    #expect(NotePaths.displayName("a/image.png", isFolder: false) == "image.png")
  }
}

@Suite("Templates, text, links")
struct TextSupportTests {
  @Test func wordsCountLikeTheWebStatusBar() {
    #expect(TextMetrics.countWords("") == 0)
    #expect(TextMetrics.countWords("- [ ] Book flights to Lisbon") == 4)
    #expect(TextMetrics.countWords("don't stop — 3 times, naïve café") == 6)
    #expect(TextMetrics.countWords("日本語 テキスト") == 2)
  }

  @Test func onlyWebAndMailLinksOpen() throws {
    #expect(ExternalLinks.isAllowed(try #require(URL(string: "https://example.com"))))
    #expect(ExternalLinks.isAllowed(try #require(URL(string: "mailto:someone@example.com"))))
    #expect(!ExternalLinks.isAllowed(try #require(URL(string: "file:///etc/passwd"))))
    #expect(!ExternalLinks.isAllowed(try #require(URL(string: "javascript:alert(1)"))))
    #expect(!ExternalLinks.isAllowed(try #require(URL(string: "x-custom://open"))))
  }

  @Test func badgeLabelsMatchTheWeb() {
    func label(_ status: TaskAgentStatus, _ summary: String? = nil) -> String? {
      BadgeBuilder.label(
        for: .sample("t", note: "n.md", text: "x", line: 0, status: status, summary: summary))
    }
    #expect(label(.triaging) == "Triaging…")
    #expect(label(.working) == "Working…")
    #expect(label(.working, "Searching fares") == "Searching fares")
    #expect(label(.waitingApproval) == "Needs approval")
    #expect(label(.waitingUser) == "Needs your input")
    #expect(label(.done, "3 options") == "Done · 3 options")
    #expect(label(.failed) == "Failed")
    #expect(label(.cancelled) == "Stopped")
    #expect(label(.idle) == nil)
    #expect(label(.ignored) == nil)
    #expect(label(TaskAgentStatus(rawValue: "future_status")) == nil)
  }

  @Test func launchOptionsDetectDemoMode() {
    #expect(LaunchOptions(arguments: ["app", "--demo"], environment: [:]).demo)
    #expect(LaunchOptions(arguments: ["app"], environment: ["DDL_DEMO": "1"]).demo)
    #expect(!LaunchOptions(arguments: ["app"], environment: ["DDL_DEMO": "0"]).demo)
  }
}

@MainActor
@Suite("Settings store")
struct SettingsStoreTests {
  @Test func patchesAreOptimisticAndConfirmed() async {
    let client = FakeDaemonClient()
    let store = SettingsStore()
    store.client = client
    var changes: [Double] = []
    store.onChange = { _, new in changes.append(new.editor.fontSize) }
    await store.update(SettingsPatch(editor: .init(fontSize: 18)))
    #expect(store.settings.editor.fontSize == 18)
    #expect(changes == [18])
    #expect(client.withState { $0.settings.editor.fontSize } == 18)
  }

  @Test func failedPatchIsRevertedAndReported() async {
    let client = FakeDaemonClient()
    client.fail(
      "updateSettings",
      with: .http(
        status: 400, body: ApiErrorBody(error: .invalidSettings, message: "fontSize out of range")))
    let store = SettingsStore()
    store.client = client
    var errors: [String] = []
    store.onError = { errors.append(ToastStore.message(for: $0)) }
    await store.update(SettingsPatch(theme: .light))
    #expect(store.settings.theme == .dark)
    #expect(errors == ["fontSize out of range"])
  }
}

@MainActor
@Suite("Search")
struct SearchModelTests {
  @Test func resultsAreDebouncedAndGroupedByNote() async throws {
    let client = FakeDaemonClient(notes: [
      "Plan.md": "flights\nhotel", "Daily/2026-09-23.md": "- [ ] book flights",
    ])
    let scheduler = ManualScheduler()
    let search = SearchModel(client: client, scheduler: scheduler)
    search.query = "fli"
    search.query = "flights"
    #expect(search.isLoading)
    await settle()
    #expect(client.calls("search").isEmpty)
    scheduler.advance(by: 0.18)
    try await eventually { !search.isLoading }
    #expect(client.calls("search") == ["search:flights"])
    #expect(search.groups.map(\.path) == ["Daily/2026-09-23.md", "Plan.md"])
    #expect(search.hitCount == 2)
    let hit = try #require(search.groups.first?.hits.first)
    #expect(SearchGroup.lineLabel(for: hit) == "1")
  }

  @Test func nameHitsComeBeforeContentHits() {
    let groups = SearchModel.group([
      SearchHit(path: "Plan.md", kind: .content, line: 3, preview: "plan b"),
      SearchHit(path: "Plan.md", kind: .name, line: 0, preview: "Plan.md"),
      SearchHit(path: "Other.md", kind: .content, line: 0, preview: "plan"),
    ])
    #expect(groups.map(\.path) == ["Plan.md", "Other.md"])
    #expect(groups[0].hits.map(\.kind) == [.name, .content])
    #expect(SearchGroup.lineLabel(for: groups[0].hits[0]) == "·")
    #expect(SearchGroup.lineLabel(for: groups[0].hits[1]) == "4")
  }

  @Test func clearingTheQueryClearsResults() async {
    let search = SearchModel(client: FakeDaemonClient(), scheduler: ManualScheduler())
    search.query = "x"
    search.query = ""
    #expect(!search.isLoading)
    #expect(search.groups.isEmpty)
  }
}

@Suite("Daily notes settings preview")
struct DailyPreviewTests {
  @Test func previewShowsTodaysPathAndMissingTemplates() {
    let today = LocalDate(year: 2026, month: 9, day: 23)
    let preview = DailyNotePreview.make(.defaults, files: [], today: today)
    #expect(preview.path == "Daily/2026-09-23.md")
    #expect(preview.problems.isEmpty)
    #expect(preview.templateMissing)
    let withTemplate = DailyNotePreview.make(.defaults, files: ["Templates/Daily.md"], today: today)
    #expect(!withTemplate.templateMissing)
  }

  @Test func formatsWithoutADateAreFlagged() {
    let preview = DailyNotePreview.make(
      DailyNoteSettings(folder: "Daily", format: "notes", template: ""), files: [],
      today: LocalDate(year: 2026, month: 9, day: 23))
    #expect(!preview.problems.isEmpty)
  }
}

@MainActor
@Suite("Preferences")
struct PreferencesTests {
  @Test func overridesPersistAndLayerOnTheStandardConfiguration() {
    let defaults = testDefaults()
    let preferences = AppPreferences(
      defaults: defaults, environment: ["DDL_HOME": "/opt/ddl-test-home", "DDL_PORT": "7444"])
    #expect(preferences.launchConfiguration.home.path == "/opt/ddl-test-home")
    #expect(preferences.launchConfiguration.port == 7444)
    preferences.managedPortOverride = 7555
    preferences.agentMode = .mock
    preferences.vaultPath = "/opt/ddl-test-vault"
    preferences.lastOpenTabs = ["a.md"]
    let reloaded = AppPreferences(defaults: defaults, environment: [:])
    #expect(reloaded.launchConfiguration.port == 7555)
    #expect(reloaded.launchConfiguration.agentMode == "mock")
    #expect(reloaded.launchConfiguration.vaultPath?.path == "/opt/ddl-test-vault")
    #expect(reloaded.launchConfiguration.manageProcess)
    #expect(reloaded.lastOpenTabs == ["a.md"])
  }

  @Test func externalURLIsValidated() {
    let preferences = AppPreferences(defaults: testDefaults(), environment: [:])
    preferences.externalBaseURL = "http://127.0.0.1:7331"
    #expect(preferences.externalURL != nil)
    preferences.externalBaseURL = "not a url"
    #expect(preferences.externalURL == nil)
    preferences.externalBaseURL = "ftp://host"
    #expect(preferences.externalURL == nil)
  }
}
