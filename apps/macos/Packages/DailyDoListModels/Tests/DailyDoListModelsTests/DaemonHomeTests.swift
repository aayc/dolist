import DailyDoListModels
import Testing

struct DaemonHomeTests {
  @Test func pathsInMessagesAbbreviateTheHomeFolder() {
    #expect(
      DaemonHome.displayPath("/Users/me/.daily-do-list/daemon-token", homeDirectory: "/Users/me")
        == "~/.daily-do-list/daemon-token")
    #expect(DaemonHome.displayPath("/Users/me", homeDirectory: "/Users/me") == "~")
    #expect(DaemonHome.displayPath("/Users/me2", homeDirectory: "/Users/me") == "/Users/me2")
    #expect(DaemonHome.displayPath("/Users/you/x", homeDirectory: "/Users/me") == "/Users/you/x")
  }
}
