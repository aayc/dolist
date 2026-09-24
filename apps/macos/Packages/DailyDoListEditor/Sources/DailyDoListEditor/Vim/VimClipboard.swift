import AppKit
import DailyDoListVim

/// A pasteboard vim reads and writes plain text on (behind a protocol so tests use a private one).
@MainActor
public protocol VimPasteboard: AnyObject {
  /// Changes whenever anyone writes to the pasteboard.
  var changeCount: Int { get }
  func string() -> String?
  func setString(_ string: String)
}

/// An `NSPasteboard` as vim's clipboard (`.general` in the app).
@MainActor
public final class SystemVimPasteboard: VimPasteboard {
  public let pasteboard: NSPasteboard

  public init(_ pasteboard: NSPasteboard = .general) {
    self.pasteboard = pasteboard
  }

  public var changeCount: Int { pasteboard.changeCount }

  public func string() -> String? { pasteboard.string(forType: .string) }

  public func setString(_ string: String) {
    pasteboard.clearContents()
    pasteboard.setString(string, forType: .string)
  }
}

/// The system clipboard as vim sees it (the web app's `SystemClipboard`): what vim last wrote,
/// keeping its shape (linewise, blockwise), while the pasteboard still holds it; else what another
/// app copied, linewise when it ends with a line break (like Vim).
@MainActor
final class VimSystemClipboard {
  struct Content: Equatable {
    var text: String
    var linewise: Bool
    var blockwise: Bool
  }

  let pasteboard: VimPasteboard
  private var written: (content: Content, changeCount: Int)?

  init(pasteboard: VimPasteboard) {
    self.pasteboard = pasteboard
  }

  var content: Content {
    if let written, written.changeCount == pasteboard.changeCount { return written.content }
    let text = pasteboard.string() ?? ""
    return Content(text: text, linewise: text.hasSuffix("\n"), blockwise: false)
  }

  func write(_ content: Content) {
    pasteboard.setString(content.text)
    written = (content, pasteboard.changeCount)
  }
}

/// A vim register backed by the system clipboard (`+` and `*`): reads return the clipboard's
/// content, writes go to it. Vim reads a register's shape from its stored flags, so reads bring
/// them up to date with the clipboard first.
@MainActor
final class PasteboardRegister: VimRegister {
  let clipboard: VimSystemClipboard
  /// `VimRegister.init` clears the register, which mustn't empty the system clipboard.
  private var isReady = false

  init(clipboard: VimSystemClipboard) {
    self.clipboard = clipboard
    super.init()
    isReady = true
  }

  override var text: VimText {
    sync()
    return super.text
  }

  /// Takes the clipboard's content without writing it back.
  func sync() {
    let content = clipboard.content
    if super.text.string != content.text || linewise != content.linewise
      || blockwise != content.blockwise
    {
      super.setText(VimText(content.text), linewise: content.linewise, blockwise: content.blockwise)
    }
  }

  override func setText(_ text: VimText, linewise: Bool = false, blockwise: Bool = false) {
    clipboard.write(.init(text: text.string, linewise: linewise, blockwise: blockwise))
    super.setText(text, linewise: linewise, blockwise: blockwise)
  }

  /// `"+A…` appends (vim.js semantics: a linewise append adds a line break first).
  override func pushText(_ text: VimText, linewise: Bool = false) {
    let current = clipboard.content
    let separator = linewise && !current.linewise && !current.text.isEmpty ? "\n" : ""
    let next = VimSystemClipboard.Content(
      text: current.text + separator + text.string, linewise: current.linewise || linewise,
      blockwise: false)
    clipboard.write(next)
    super.setText(VimText(next.text), linewise: next.linewise, blockwise: false)
  }

  override func clear() {
    super.clear()
    if isReady { clipboard.write(.init(text: "", linewise: false, blockwise: false)) }
  }
}
