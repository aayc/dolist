import Foundation

@testable import DailyDoListEditor

/// A synthetic daily note exercising every construct the editor styles.
enum SampleNote {
  static let text = """
    ---
    title: Daily note
    tags: [daily, planning]
    ---
    # Wednesday, September 23

    Plan for today with **bold**, *italic*, `inline code`, ~~strike~~ and ==highlight==.
    See [[Projects/Launch|the launch plan]], [the docs](https://example.com/docs) or https://example.com/a_b_c #planning

    ## Tasks
    - [ ] Research flights to Lisbon for the conference
    - [x] Book a table for Friday dinner 🍝
    - [/] Draft the quarterly update email
    - [-] Cancelled idea
    - [>] Deferred to next week
    \t- [ ] Nested follow-up with a much longer description that should wrap onto a second line of the note
    - Plain bullet with a [[Wiki Link]]
    1. First ordered item
    2. [ ] Ordered task

    > A quote with **emphasis**
    > > Nested quote

    ---

    ```swift
    let answer = 42 // **not bold**
    ```
    ### Heading three
    Last line.
    """

  static func badges(for text: String) -> [EditorBadge] {
    let lines = text.components(separatedBy: "\n")
    func line(_ prefix: String) -> Int { lines.firstIndex { $0.hasPrefix(prefix) } ?? 0 }
    return [
      EditorBadge(
        id: "t1", line: line("- [ ] Research"), status: "working", label: "Researching…", unread: 0),
      EditorBadge(
        id: "t2", line: line("- [x] Book"), status: "done", label: "Done · 3 options", unread: 2),
      EditorBadge(
        id: "t3", line: line("- [/] Draft"), status: "waiting_approval", label: "Needs approval"),
      EditorBadge(id: "t4", line: line("\t- [ ] Nested"), status: "queued", label: "Queued"),
      EditorBadge(id: "t5", line: line("- [-] Cancelled"), status: "idle", label: "Hidden"),
    ]
  }

  /// A long note (about `lines` lines) mixing every construct, for performance tests.
  static func long(lines: Int) -> String {
    let block = text.components(separatedBy: "\n")
    var result: [String] = []
    var index = 0
    while result.count < lines {
      let line = block[index % block.count]
      // Keep a single frontmatter block at the top.
      if index >= block.count, index % block.count < 4 {
        result.append("- [ ] Task \(index) with **bold** and [[Link \(index)]]")
      } else {
        result.append(line)
      }
      index += 1
    }
    return result.joined(separator: "\n")
  }
}
