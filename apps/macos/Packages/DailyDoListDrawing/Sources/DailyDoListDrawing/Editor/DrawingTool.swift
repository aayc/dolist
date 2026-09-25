import DailyDoListUI
import Foundation

/// A tool of the tool bar, with Excalidraw's shortcuts (`SHAPES` in `shapes.tsx`): a letter and
/// a number key, no modifiers.
public enum DrawingTool: String, CaseIterable, Hashable, Sendable {
  case selection
  case rectangle
  case diamond
  case ellipse
  case arrow
  case line
  case freedraw
  case text
  case eraser
  case hand

  /// The tools in the tool bar, in Excalidraw's order.
  public static let toolbarTools: [DrawingTool] = [
    .hand, .selection, .rectangle, .diamond, .ellipse, .arrow, .line, .freedraw, .text, .eraser,
  ]

  /// The tooltip's name.
  public var label: String {
    switch self {
    case .selection: "Selection"
    case .rectangle: "Rectangle"
    case .diamond: "Diamond"
    case .ellipse: "Ellipse"
    case .arrow: "Arrow"
    case .line: "Line"
    case .freedraw: "Draw"
    case .text: "Text"
    case .eraser: "Eraser"
    case .hand: "Hand (panning tool)"
    }
  }

  /// The SF Symbol drawn in the tool bar.
  public var symbol: String {
    switch self {
    case .selection: "cursorarrow"
    case .rectangle: "square"
    case .diamond: "diamond"
    case .ellipse: "circle"
    case .arrow: "arrow.right"
    case .line: "line.diagonal"
    case .freedraw: "pencil"
    case .text: "character"
    case .eraser: "eraser"
    case .hand: "hand.raised"
    }
  }

  /// The letter key (shown in the tooltip).
  public var shortcut: KeyShortcut {
    KeyShortcut(.character(Self.letters[self]!.first!), [])
  }

  /// Every key that picks the tool: its letters, then its number.
  public var keys: [Character] {
    var keys = Array(Self.letters[self] ?? "")
    if let number = Self.numbers[self] { keys.append(number) }
    return keys
  }

  static let letters: [DrawingTool: String] = [
    .selection: "v", .rectangle: "r", .diamond: "d", .ellipse: "o", .arrow: "a", .line: "l",
    .freedraw: "px", .text: "t", .eraser: "e", .hand: "h",
  ]
  static let numbers: [DrawingTool: Character] = [
    .selection: "1", .rectangle: "2", .diamond: "3", .ellipse: "4", .arrow: "5", .line: "6",
    .freedraw: "7", .text: "8", .eraser: "0",
  ]

  /// The tool a key picks (letters case-insensitive).
  public static func tool(forKey character: Character) -> DrawingTool? {
    let lower = Character(character.lowercased())
    return allCases.first { $0.keys.contains(lower) }
  }

  /// Tools that create elements of a type.
  public var elementType: ElementType? {
    switch self {
    case .rectangle: .rectangle
    case .diamond: .diamond
    case .ellipse: .ellipse
    case .arrow: .arrow
    case .line: .line
    case .freedraw: .freedraw
    case .text: .text
    default: nil
    }
  }
}

/// The editing commands and their shortcuts (Excalidraw's), one table for the canvas and its
/// tooltips.
public enum DrawingCommand: String, CaseIterable, Hashable, Sendable {
  case undo
  case redo
  case delete
  case duplicate
  case selectAll
  case lockTool

  public var label: String {
    switch self {
    case .undo: "Undo"
    case .redo: "Redo"
    case .delete: "Delete"
    case .duplicate: "Duplicate"
    case .selectAll: "Select all"
    case .lockTool: "Keep selected tool active after drawing"
    }
  }

  public var shortcut: KeyShortcut {
    switch self {
    case .undo: KeyShortcut("z")
    case .redo: KeyShortcut("z", [.shift, .command])
    case .delete: KeyShortcut(.delete)
    case .duplicate: KeyShortcut("d")
    case .selectAll: KeyShortcut("a")
    case .lockTool: KeyShortcut(.character("q"), [])
    }
  }
}
