import DailyDoListDomain
import DailyDoListModels
import Foundation
import Testing

extension DomainTests {
  struct VaultTreeTests {
    private let en = Locale(identifier: "en_US")

    private func file(_ path: String) -> VaultEntry { VaultEntry(path: path, kind: .file) }
    private func folder(_ path: String) -> VaultEntry { VaultEntry(path: path, kind: .folder) }
    private func shape(_ nodes: [VaultTreeNode]) -> [String] {
      VaultTree.flatten(nodes).map { "\($0.path)|\($0.kind.rawValue)" }
    }

    @Test func nestsSortsAndNamesLikeTheWebExplorer() {
      let tree = VaultTree.build(
        [
          file("Day 10.md"), file("Day 2.md"), file("attachments/photo.png"), folder("Projects"),
          file("Projects/b.md"), file("Projects/A.md"), file("Daily/2026-09-23.md"),
        ], locale: en)
      #expect(tree.map(\.name) == ["attachments", "Daily", "Projects", "Day 2", "Day 10"])
      #expect(tree[0].children.map(\.name) == ["photo.png"])
      #expect(tree[2].children.map(\.name) == ["A", "b"])
      #expect(tree[1].isFolder && tree[1].id == "Daily")
      #expect(tree[3].outlineChildren == nil && tree[1].outlineChildren?.count == 1)
    }

    @Test func impliedFoldersAndEmptyFolders() {
      let tree = VaultTree.build([file("a/b/c/d/e/f/g/h/i/j/k.md"), folder("empty"), folder("empty/nested-empty")], locale: en)
      #expect(tree.map(\.path) == ["a", "empty"])
      #expect(VaultTree.node(at: "a/b/c/d/e/f/g/h/i/j/k.md", in: tree)?.name == "k")
      #expect(VaultTree.node(at: "empty/nested-empty", in: tree)?.children == [])
      #expect(VaultTree.node(at: "a/missing.md", in: tree) == nil)
    }

    @Test func orderDoesNotDependOnTheInput() {
      let entries = [
        file("note.md"), file("Note.md"), file("résumé.md"), file("resume.md"), file("Straße 2.md"),
        file("Strasse 10.md"), file("x/Day 10.md"), file("x/Day 2.md"), folder("x/sub"), file("10.md"),
        file("9.md"), file("日本.md"), file("😀.md"),
      ]
      let expected = shape(VaultTree.build(entries, locale: en))
      for seed in 0..<20 {
        var generator = SeededGenerator(seed: UInt64(seed))
        #expect(shape(VaultTree.build(entries.shuffled(using: &generator), locale: en)) == expected)
      }
      // Names equal to the collator fall back to code units, so the order is total.
      #expect(expected.prefix(2) == ["x|folder", "x/sub|folder"])
      #expect(expected.contains("Note.md|file") && expected.firstIndex(of: "Note.md|file")! < expected.firstIndex(of: "note.md|file")!)
    }

    @Test func distinctUnicodeSpellingsStayDistinct() {
      let tree = VaultTree.build([file("Caf\u{e9}/a.md"), file("Cafe\u{301}/b.md")], locale: en)
      #expect(tree.count == 2)
      #expect(Set(tree.map { $0.children.count }) == [1])
    }

    @Test func revealAndFlatten() {
      let tree = VaultTree.build([file("a/b/c.md"), file("a/d.md"), file("e.md")], locale: en)
      #expect(VaultTree.ancestors(of: "a/b/c.md") == ["a", "a/b"])
      let expanded = VaultTree.revealing("a/b/c.md", in: [])
      #expect(expanded == ["a", "a/b"])
      let rows = VaultTree.visibleRows(tree, expanded: expanded)
      #expect(rows.map(\.path) == ["a", "a/b", "a/b/c.md", "a/d.md", "e.md"])
      #expect(rows.map(\.depth) == [0, 1, 2, 1, 0])
      #expect(rows[0].isExpanded && rows[0].hasChildren && !rows[2].hasChildren)
      #expect(VaultTree.visibleRows(tree, expanded: []).map(\.path) == ["a", "e.md"])
      #expect(VaultTree.displayName(path: "x/README", kind: .file) == "README")
      #expect(VaultTree.displayName(path: "x/Notes.MD", kind: .file) == "Notes")
      #expect(VaultTree.displayName(path: "x/folder.md", kind: .folder) == "folder.md")
    }
  }
}

/// SplitMix64, for reproducible shuffles.
struct SeededGenerator: RandomNumberGenerator {
  private var state: UInt64
  init(seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
