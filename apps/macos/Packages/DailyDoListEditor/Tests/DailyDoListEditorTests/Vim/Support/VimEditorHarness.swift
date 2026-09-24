import AppKit
import DailyDoListVim

@testable import DailyDoListEditor

/// Records what vim asks the editor's host for.
@MainActor
final class VimRecordingDelegate: MarkdownEditorDelegate {
  var statuses: [EditorVimStatus?] = []
  var requests: [EditorVimRequest] = []
  var saves = 0
  var textChanges = 0
  /// What `perform` answers.
  var result: EditorVimRequestResult = .done

  func editor(_ editor: MarkdownEditorController, vimStatusDidChange status: EditorVimStatus?) {
    statuses.append(status)
  }
  func editor(_ editor: MarkdownEditorController, perform request: EditorVimRequest)
    -> EditorVimRequestResult
  {
    requests.append(request)
    return result
  }
  func editorDidRequestSave(_ editor: MarkdownEditorController) { saves += 1 }
  func editorTextDidChange(_ editor: MarkdownEditorController, text: String) { textChanges += 1 }
}

/// An offscreen window that can claim to be the key window (a test process can't activate).
final class VimTestWindow: NSWindow {
  var reportsKey = false
  override var isKeyWindow: Bool { reportsKey || super.isKeyWindow }
}

/// A vim-mode editor in an offscreen window, driven with real key events (`keyDown` through
/// `NSEvent`s, so NSTextView's own key handling runs for the keys vim leaves to it).
@MainActor
final class VimEditorHarness {
  let controller: MarkdownEditorController
  let window: VimTestWindow
  let vim: Vim
  let scheduler = ManualVimScheduler()
  let delegate = VimRecordingDelegate()
  let integration: EditorVimIntegration?
  let pasteboard: NSPasteboard
  /// Milliseconds reported to vim's undo grouping (advance it to separate typing bursts).
  var now: Double = 1_700_000_000_000

  /// `marked` uses `|` for the caret (see `parseMarked`); without one the caret starts at 0.
  init(
    _ marked: String = "",
    configuration: EditorConfiguration = EditorConfiguration(livePreview: false, vimMode: true),
    size: NSSize = NSSize(width: 800, height: 600), integrated: Bool = true
  ) {
    let hasMarker = marked.contains("|") || marked.contains("«")
    let (text, parsed) = hasMarker ? parseMarked(marked) : (marked, NSRange(location: 0, length: 0))
    let selection = parsed
    controller = MarkdownEditorController(configuration: configuration)
    window = VimTestWindow(
      contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = controller.view
    controller.view.frame = NSRect(origin: .zero, size: size)
    controller.view.layoutSubtreeIfNeeded()
    controller.delegate = delegate
    controller.setText(text, resetUndo: true)
    controller.noteUndoManager.groupsByEvent = false
    vim = Vim(scheduler: scheduler, isMac: true)
    pasteboard = NSPasteboard(name: NSPasteboard.Name("ddl.tests.vim.\(UUID().uuidString)"))
    integration =
      integrated ? EditorVimIntegration(vim: vim, pasteboard: SystemVimPasteboard(pasteboard)) : nil
    controller.vim = vim
    window.makeFirstResponder(controller.textView)
    host.clock = { [weak self] in self?.now ?? 0 }
    if selection.location > 0 || selection.length > 0 {
      host.setSelection(
        VimSelection(ranges: [.init(anchor: selection.location, head: selection.end)]))
      session?.editorSelectionDidChange()
    }
    delegate.statuses.removeAll()
  }

  deinit {
    MainActor.assumeIsolated {
      pasteboard.releaseGlobally()
      window.close()
    }
  }

  var host: TextViewVimHost { controller.vimHost }
  var session: VimSession? { controller.vimSession }
  var textView: MarkdownTextView { controller.markdownTextView }
  var text: String { controller.text }
  var mode: VimSession.Mode? { session?.mode }
  var undoManager: UndoManager { controller.noteUndoManager }

  /// The main cursor as an offset.
  var cursor: Int { host.selection.main.head }

  /// The text with `|` at the main cursor.
  var marked: String {
    let ns = text as NSString
    return ns.replacingCharacters(in: NSRange(location: cursor, length: 0), with: "|")
  }

  /// Presses keys given in vim notation ("i", "<Esc>", "<C-d>", "<CR>", "<S-Tab>", "<D-v>").
  func press(_ keys: String...) {
    for key in keys { send(Self.event(for: key, window: window)) }
  }

  /// Types each character as a key press.
  func type(_ characters: String) {
    for character in characters {
      press(character == "\n" ? "<CR>" : String(character))
    }
  }

  func send(_ event: NSEvent) {
    textView.keyDown(with: event)
  }

  /// Runs `action` in an undo group of its own (the text view registers undo itself while vim is
  /// off, and tests have no run loop closing its groups).
  func act(_ action: () -> Void) {
    undoManager.beginUndoGrouping()
    action()
    undoManager.endUndoGrouping()
  }

  /// A key event for a key in vim notation, as the keyboard would send it.
  static func event(for key: String, window: NSWindow? = nil, isRepeat: Bool = false) -> NSEvent {
    var flags: NSEvent.ModifierFlags = []
    var name = key
    if key.count > 2, key.hasPrefix("<"), key.hasSuffix(">") {
      var inner = String(key.dropFirst().dropLast())
      while inner.count > 2, inner[inner.index(after: inner.startIndex)] == "-" {
        switch inner.first {
        case "C": flags.insert(.control)
        case "S": flags.insert(.shift)
        case "A": flags.insert(.option)
        case "D", "M": flags.insert(.command)
        default: break
        }
        inner.removeFirst(2)
      }
      name = inner
    }
    let named: [String: (UInt16, String)] = [
      "Esc": (53, "\u{1b}"), "CR": (36, "\r"), "BS": (51, "\u{7f}"), "Del": (117, "\u{F728}"),
      "Tab": (48, "\t"),
      "Left": (123, "\u{F702}"), "Right": (124, "\u{F703}"), "Down": (125, "\u{F701}"),
      "Up": (126, "\u{F700}"),
      "Home": (115, "\u{F729}"), "End": (119, "\u{F72B}"), "PageUp": (116, "\u{F72C}"),
      "PageDown": (121, "\u{F72D}"),
      "F1": (122, "\u{F704}"), "F12": (111, "\u{F70F}"), "Space": (49, " "),
    ]
    let keyCode: UInt16
    var characters: String
    var ignoring: String
    if let (code, chars) = named[name] {
      keyCode = code
      characters = chars
      ignoring = chars
    } else {
      // Keys without a US position get a code with no DOM name.
      keyCode = codes[name.lowercased()] ?? 0x7F
      ignoring = flags.contains(.shift) ? name.uppercased() : name
      characters = ignoring
      if flags.contains(.control), let scalar = name.lowercased().unicodeScalars.first,
        scalar.isASCII,
        (97...122).contains(scalar.value)
      {
        characters = String(UnicodeScalar(UInt8(scalar.value - 96)))
      }
    }
    if flags.contains(.shift), name.count == 1, named[name] == nil {
      characters = name.uppercased()
    }
    return NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: flags,
      timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: window?.windowNumber ?? 0, context: nil, characters: characters,
      charactersIgnoringModifiers: ignoring,
      isARepeat: isRepeat, keyCode: keyCode)!
  }

  private static let codes: [String: UInt16] = {
    var map: [String: UInt16] = [:]
    for (code, name) in VimKeyEvents.codes {
      if name.hasPrefix("Key") { map[name.dropFirst(3).lowercased()] = code }
      if name.hasPrefix("Digit") { map[String(name.dropFirst(5))] = code }
    }
    return map
  }()
}
