import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListAgent

/// The activity labels (the web app's tests share these cases) and when the live row shows.
@Suite("Chat activity")
struct ChatActivityTests {
  static func call(
    _ toolName: String, _ input: JSONValue = [:], label: String? = nil, id: String = "msg_call",
    createdAt: EpochMillis = 1_000, status: ToolCallStatus = .running
  ) -> ToolCallMessage {
    ToolCallMessage(
      id: id, author: "subagent:research", createdAt: createdAt, toolCallId: "call_\(id)",
      toolName: toolName, label: label, input: input, status: status)
  }

  static let labels: [(tool: String, input: JSONValue, label: String?, expected: String)] = [
    ("computer_open_app", ["app": "Safari"], nil, "Opening Safari…"),
    ("computer_open_app", [:], nil, "Opening an app…"),
    ("computer_app_state", ["app": "Notes"], nil, "Looking at Notes…"),
    ("computer_screenshot", ["app": "Safari"], nil, "Looking at Safari…"),
    ("computer_screenshot", [:], "Look at the screen", "Looking at the screen…"),
    (
      "computer_press", ["app": "Mail", "id": "e3", "element": "Send"], nil,
      "Pressing “Send” in Mail…"
    ),
    ("computer_press", ["app": "Mail", "id": "e3"], nil, "Pressing a control in Mail…"),
    (
      "computer_set_value", ["app": "Notes", "id": "e1", "value": "hunter2"], nil,
      "Typing in Notes…"
    ),
    ("computer_type", ["text": "hello"], nil, "Typing…"),
    ("computer_key", ["combo": "cmd+s", "app": "TextEdit"], nil, "Pressing cmd+s in TextEdit…"),
    ("computer_key", ["app": "TextEdit"], nil, "Pressing a key in TextEdit…"),
    ("computer_click", ["app": "Finder", "element": "Downloads"], nil, "Clicking in Finder…"),
    ("computer_click", ["x": 10, "y": 20, "element": "OK"], nil, "Clicking on the screen…"),
    ("computer_scroll", ["dx": 0, "dy": 3], nil, "Scrolling on the screen…"),
    ("computer_scroll", ["app": "Safari", "dx": 0, "dy": 5], nil, "Scrolling in Safari…"),
    (
      "browser_navigate", ["url": "https://www.Example.com/menu?day=fri"], nil,
      "Opening www.example.com…"
    ),
    ("browser_navigate", ["url": "not a url"], nil, "Opening a page…"),
    ("browser_snapshot", [:], nil, "Reading the page…"),
    ("browser_extract_text", ["maxChars": 2000], nil, "Reading the page…"),
    ("browser_click", ["element": "Reserve button"], "Click", "Working in the browser…"),
    (
      "web_search", ["query": "espresso grinders under $300"], "Search the web",
      "Searching the web for “espresso grinders under $300”…"
    ),
    (
      "web_search", ["query": "compare standing desks under five hundred dollars with presets"],
      nil,
      "Searching the web for “compare standing desks under five hundr…”…"
    ),
    ("web_search", ["query": "  two\n  lines  "], nil, "Searching the web for “two lines”…"),
    ("web_search", [:], nil, "Searching the web…"),
    (
      "web_fetch", ["url": "https://news.example/story/4"], "Fetch web page",
      "Reading news.example…"
    ),
    ("web_fetch", [:], nil, "Reading a page…"),
    ("read_note", ["path": "Daily/2026-09-24.md"], nil, "Reading your notes…"),
    ("search_notes", ["query": "passport"], nil, "Reading your notes…"),
    ("read_drawing", ["path": "Excalidraw/Flow.excalidraw.md"], nil, "Looking at “Flow”…"),
    (
      "read_drawing", ["path": "![[Kitchen layout.excalidraw|360|right-wrap]]"], "Look at drawing",
      "Looking at “Kitchen layout”…"
    ),
    ("read_drawing", [:], nil, "Looking at a drawing…"),
    ("edit_note", ["path": "Daily/2026-09-24.md"], nil, "Editing your note…"),
    ("bash", ["command": "ls -la"], nil, "Running a command…"),
    ("read", ["path": "a.txt"], nil, "Looking through files…"),
    ("grep", ["pattern": "x"], nil, "Looking through files…"),
    ("find", ["pattern": "*.md"], nil, "Looking through files…"),
    ("ls", [:], nil, "Looking through files…"),
    ("write", ["path": "a.txt"], nil, "Writing files…"),
    ("edit", ["path": "a.txt"], nil, "Writing files…"),
    ("mcp__github__create_issue", ["title": "Bug"], "Create issue", "Using github…"),
    ("mcp__google_drive__search", [:], nil, "Using google_drive…"),
    ("create_artifact", ["title": "Options"], "Create artifact", "Create artifact…"),
    ("post_update", [:], nil, "Post update…"),
    ("spawn_subagent", [:], "Delegate…", "Delegate…"),
  ]

  @Test(arguments: labels)
  func labelsSayWhatTheToolDoes(tool: String, input: JSONValue, label: String?, expected: String) {
    #expect(ChatActivity.label(for: Self.call(tool, input, label: label)) == expected)
  }

  @Test func quotedStringsAreClippedToFortyCharacters() {
    let clipped = ChatActivity.clip(String(repeating: "a", count: 60))
    #expect(clipped.count == 40)
    #expect(clipped.hasSuffix("…"))
    #expect(ChatActivity.clip("short") == "short")
    #expect(ChatActivity.clip(String(repeating: "b", count: 40)).count == 40)
  }

  // MARK: The live row

  static let approval = Fixture.approval(createdAt: 5_000)

  @Test(arguments: [TaskAgentStatus.idle, .done, .failed, .cancelled, .ignored, .waitingUser])
  func noRowWhenTheAgentIsntQueuedOrRunning(status: TaskAgentStatus) {
    #expect(
      ChatActivity.current(
        status: status, messages: [.toolCall(Self.call("bash"))], pendingApprovals: [],
        isTextActive: false) == nil)
  }

  @Test func queuedWaitsToStart() {
    let activity = ChatActivity.current(
      status: .queued, messages: [Fixture.text("m1", "Queued", streaming: nil, createdAt: 700)],
      pendingApprovals: [], isTextActive: false)
    #expect(activity?.kind == .waitingToStart)
    #expect(activity?.label == "Waiting to start…")
    #expect(activity?.since == 700)
  }

  @Test func aPendingApprovalComesFirstAndPointsAtItsCard() {
    let messages: [ThreadMessage] = [
      .toolCall(Self.call("browser_click")),
      .approval(
        ApprovalMessage(id: "msg_apr", author: "system", createdAt: 5_000, approvalId: "apr_1")),
    ]
    let activity = ChatActivity.current(
      status: .waitingApproval, messages: messages, pendingApprovals: [Self.approval],
      isTextActive: true)
    #expect(activity?.kind == .approval(approvalId: "apr_1", messageId: "msg_apr"))
    #expect(activity?.label == "Waiting for your approval")
    #expect(activity?.since == 5_000)
  }

  @Test func theLatestRunningToolCallSaysWhatsHappening() {
    let messages: [ThreadMessage] = [
      .toolCall(Self.call("web_search", ["query": "old"], id: "a", createdAt: 1_000)),
      .toolCall(Self.call("computer_open_app", ["app": "Safari"], id: "b", createdAt: 2_000)),
      .toolCall(Self.call("bash", id: "c", createdAt: 3_000, status: .ok)),
    ]
    let activity = ChatActivity.current(
      status: .working, messages: messages, pendingApprovals: [], isTextActive: false)
    #expect(activity?.kind == .tool(name: "computer_open_app"))
    #expect(activity?.label == "Opening Safari…")
    #expect(activity?.since == 2_000)
  }

  @Test func textTypingOutNeedsNoRow() {
    #expect(
      ChatActivity.current(
        status: .working, messages: [Fixture.text("m1", "Writing", streaming: true)],
        pendingApprovals: [], isTextActive: true) == nil)
  }

  @Test func otherwiseTheAgentIsThinkingSinceTheLastThingThatHappened() {
    let messages: [ThreadMessage] = [
      Fixture.text("m1", "Started", streaming: nil, createdAt: 1_000),
      .toolCall(
        ToolCallMessage(
          id: "t", author: "subagent:x", createdAt: 2_000, toolCallId: "c", toolName: "bash",
          input: [:], status: .ok, endedAt: 4_500)),
    ]
    for status in [TaskAgentStatus.triaging, .working] {
      let activity = ChatActivity.current(
        status: status, messages: messages, pendingApprovals: [], isTextActive: false)
      #expect(activity?.kind == .thinking)
      #expect(activity?.label == "Thinking…")
      #expect(activity?.since == 4_500)
    }
  }

  @Test func elapsedShowsAfterThreeSeconds() {
    let since: EpochMillis = 1_000_000
    func at(_ seconds: Double) -> String? {
      ChatActivity.elapsed(since: since, now: Date(epochMillis: since + seconds * 1000))
    }
    #expect(at(0) == nil)
    #expect(at(2.99) == nil)
    #expect(at(3) == "3s")
    #expect(at(12.9) == "12s")
    #expect(at(65) == "1m 5s")
    #expect(at(3_725) == "1h 2m")
    #expect(ChatActivity.elapsed(since: nil, now: Date()) == nil)
  }
}

@Suite("Chat rows")
struct ChatItemsTests {
  static func call(_ id: String, _ status: ToolCallStatus) -> ThreadMessage {
    Fixture.toolCall(id, status: status)
  }

  @Test func finishedCallsInARowCollapseAndTheRestStayVisible() {
    let messages: [ThreadMessage] = [
      Fixture.text("m1", "On it", streaming: nil),
      Self.call("a", .ok), Self.call("b", .ok), Self.call("c", .ok),
      Self.call("d", .error),
      Self.call("e", .ok),
      Self.call("f", .blocked),
      Self.call("g", .ok), Self.call("h", .ok),
      Self.call("i", .running),
    ]
    let items = ChatItem.make(messages)
    #expect(items.map(\.id) == ["m1", "a", "d", "e", "f", "g", "i"])
    func calls(_ index: Int) -> [String] {
      if case .tools(let calls) = items[index].content { return calls.map(\.id) }
      return []
    }
    #expect(calls(1) == ["a", "b", "c"])
    #expect(calls(2) == ["d"])
    #expect(calls(3) == ["e"])
    #expect(calls(4) == ["f"])
    #expect(calls(5) == ["g", "h"])
    #expect(calls(6) == ["i"])
  }

  @Test func aRunKeepsItsIdAsItGrows() {
    let before = ChatItem.make([Self.call("a", .ok), Self.call("b", .running)])
    let after = ChatItem.make([Self.call("a", .ok), Self.call("b", .ok)])
    #expect(before.map(\.id) == ["a", "b"])
    #expect(after.map(\.id) == ["a"])
  }

  @Test func theDaemonsCopyOfAMessageKeepsTheOptimisticRow() {
    let items = ChatItem.make(
      [Fixture.text("msg_srv", "Hi", streaming: nil, role: .user)],
      aliases: ["msg_srv": "local-1"])
    #expect(items.map(\.id) == ["local-1"])
  }
}

extension ChatScroll {
  /// `layoutChanged` for tests: whether that layout scrolls to the bottom.
  @discardableResult
  mutating func layout(_ content: CGFloat, _ viewport: CGFloat, bottom: CGFloat) -> Bool {
    layoutChanged(contentHeight: content, viewportHeight: viewport, distanceFromBottom: bottom)
  }
}

@Suite("Chat scrolling")
struct ChatScrollTests {
  @Test func growingContentStaysPinned() {
    var scroll = ChatScroll()
    let first = scroll.layout(500, 600, bottom: -100)
    let grown = scroll.layout(900, 600, bottom: 300)
    #expect(!first)
    #expect(grown)
    #expect(scroll.isPinned)
    // Our scroll to the bottom: only the offset changed.
    let settled = scroll.layout(900, 600, bottom: 0)
    #expect(!settled)
    #expect(scroll.isPinned)
  }

  @Test func scrollingUpUnpinsAndNothingYanksTheUserDown() {
    var scroll = ChatScroll()
    scroll.layout(2_000, 600, bottom: 0)
    let scrolledUp = scroll.layout(2_000, 600, bottom: 400)
    #expect(!scrolledUp)
    #expect(!scroll.isPinned)
    scroll.arrived(2)
    let grown = scroll.layout(2_300, 600, bottom: 700)
    #expect(!grown)
    scroll.arrived(1)
    #expect(scroll.unseen == 3)
    #expect(!scroll.isPinned)
  }

  @Test func comingBackDownPinsAndClearsTheCount() {
    var scroll = ChatScroll()
    scroll.layout(2_000, 600, bottom: 0)
    scroll.layout(2_000, 600, bottom: 400)
    scroll.arrived(4)
    scroll.layout(2_000, 600, bottom: 30)
    #expect(scroll.isPinned)
    #expect(scroll.unseen == 0)
  }

  @Test func jumpingToTheLatestPinsAndClearsTheCount() {
    var scroll = ChatScroll()
    scroll.layout(2_000, 600, bottom: 0)
    scroll.layout(2_000, 600, bottom: 900)
    scroll.arrived(2)
    #expect(scroll.unseen == 2)
    scroll.jumpToLatest()
    #expect(scroll.isPinned)
    #expect(scroll.unseen == 0)
    scroll.arrived(1)
    #expect(scroll.unseen == 0, "pinned: new messages are in view")
  }

  @Test func theJumpKeepsThePillHiddenOnTheWayDown() {
    var scroll = ChatScroll()
    scroll.layout(3_000, 600, bottom: 0)
    scroll.layout(3_000, 600, bottom: 900)
    scroll.arrived(2)
    scroll.jumpToLatest()
    for distance: CGFloat in [700, 400, 120, 10, 0] {
      scroll.layout(3_000, 600, bottom: distance)
      #expect(scroll.isPinned, "at \(distance)")
      #expect(scroll.unseen == 0)
    }
    #expect(scroll.isFollowing)
    #expect(!scroll.isJumping)
  }

  @Test func scrollingAwayMidJumpShowsThePillAgain() {
    var scroll = ChatScroll()
    scroll.layout(3_000, 600, bottom: 0)
    scroll.layout(3_000, 600, bottom: 900)
    scroll.jumpToLatest()
    scroll.layout(3_000, 600, bottom: 600)
    scroll.layout(3_000, 600, bottom: 800)
    #expect(!scroll.isJumping)
    #expect(!scroll.isPinned)
    #expect(!scroll.isFollowing)
  }

  /// A nudge up stops following: rows above resizing as they load never pull the reader down.
  @Test func aSmallScrollUpStopsFollowing() {
    var scroll = ChatScroll()
    scroll.layout(2_000, 600, bottom: 0)
    scroll.layout(2_000, 600, bottom: 6)
    #expect(!scroll.isFollowing)
    #expect(scroll.isPinned, "close enough: no pill yet")
    let rowsResized = scroll.layout(2_040, 600, bottom: 46)
    #expect(!rowsResized)
    #expect(scroll.isPinned)
    let grown = scroll.layout(2_100, 600, bottom: 106)
    #expect(!grown)
    #expect(!scroll.isPinned, "the pill shows once the bottom is out of reach")
    scroll.layout(2_100, 600, bottom: 1)
    #expect(scroll.isFollowing)
  }

  @Test func aTallerComposerKeepsThePinnedBottomInView() {
    var scroll = ChatScroll()
    scroll.layout(2_000, 600, bottom: 0)
    let follows = scroll.layout(2_000, 560, bottom: 40)
    #expect(follows)
    #expect(scroll.isPinned)
  }

  @Test func onlyNewNonToolMessagesCount() {
    let old: [ThreadMessage] = [Fixture.text("m1", "a", streaming: nil)]
    let new: [ThreadMessage] =
      old + [
        Fixture.toolCall("t1"), Fixture.text("m2", "b", streaming: nil),
        .approval(ApprovalMessage(id: "ap", author: "system", createdAt: 1, approvalId: "apr_1")),
      ]
    #expect(ChatView.arrivals(from: old, to: new) == 2)
    #expect(ChatView.arrivals(from: new, to: new) == 0)
  }
}
