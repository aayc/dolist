import AppKit
import DailyDoListVim

/// Vim's command line under the editor, like the web app's `.cm-vim-panel`: a prompt (`:`, `/`,
/// `?`, `:s///c`) with its input and a caret after it (keys keep going through the editor to
/// `VimSession.handleKey`), a message (red, like vim's own), or a status line ("recording @q").
/// Monospaced 13 pt, 4 × 12 pt padding, the app's secondary background with a hairline on top.
final class VimPanelView: NSView {
  static let font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
  static let padding = NSSize(width: 12, height: 4)

  private(set) var kind: VimPanel.Kind = .message
  /// What is drawn (prefix + input, or the message).
  private(set) var text = NSAttributedString()
  /// For a prompt: the width of the prefix and input on the last line, where the caret goes.
  private var caretX: CGFloat?

  /// The text as plain characters (tests, accessibility).
  var displayedText: String { text.string }

  override var isFlipped: Bool { true }

  func show(_ panel: VimPanel) {
    kind = panel.kind
    let attributes: [NSAttributedString.Key: Any] = [
      .font: Self.font, .foregroundColor: EditorColors.panelText,
    ]
    let muted: [NSAttributedString.Key: Any] = [
      .font: Self.font, .foregroundColor: EditorColors.panelMutedText,
    ]
    let result = NSMutableAttributedString()
    switch panel.kind {
    case .prompt:
      result.append(
        NSAttributedString(string: panel.text + panel.value.string, attributes: attributes))
      let lastLine = result.string.components(separatedBy: "\n").last ?? ""
      caretX = (lastLine as NSString).size(withAttributes: attributes).width
      if let detail = panel.detail, !detail.isEmpty {
        result.append(NSAttributedString(string: "  " + detail, attributes: muted))
      }
    case .message:
      caretX = nil
      result.append(
        NSAttributedString(
          string: panel.text, attributes: [.font: Self.font, .foregroundColor: EditorColors.danger])
      )
      if panel.isLong {
        result.append(
          NSAttributedString(string: "\nPress ENTER or type command to continue", attributes: muted)
        )
      }
    case .status:
      caretX = nil
      result.append(NSAttributedString(string: panel.text, attributes: muted))
    }
    text = result
    setAccessibilityElement(true)
    setAccessibilityRole(.staticText)
    setAccessibilityLabel(result.string)
    needsDisplay = true
  }

  /// The height the panel needs at `width` (one line at least).
  func fittingHeight(forWidth width: CGFloat) -> CGFloat {
    let available = max(40, width - 2 * Self.padding.width)
    let bounds = text.boundingRect(
      with: NSSize(width: available, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin])
    let line = (Self.font.ascender - Self.font.descender + Self.font.leading).rounded(.up)
    return (max(line, bounds.height.rounded(.up)) + 2 * Self.padding.height + 1).rounded(.up)
  }

  override func draw(_ dirtyRect: NSRect) {
    EditorColors.panelBackground.setFill()
    bounds.fill()
    EditorColors.panelBorder.setFill()
    NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
    let area = NSRect(
      x: Self.padding.width, y: Self.padding.height + 1,
      width: max(0, bounds.width - 2 * Self.padding.width),
      height: max(0, bounds.height - 2 * Self.padding.height - 1))
    // A long message shows its end when it doesn't fit.
    let needed = text.boundingRect(
      with: NSSize(width: area.width, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin])
    var origin = area.origin
    if needed.height > area.height { origin.y -= needed.height - area.height }
    NSGraphicsContext.saveGraphicsState()
    NSBezierPath(rect: area).addClip()
    text.draw(
      with: NSRect(origin: origin, size: NSSize(width: area.width, height: needed.height)),
      options: [.usesLineFragmentOrigin])
    NSGraphicsContext.restoreGraphicsState()
    if let caretX {
      EditorColors.accent.setFill()
      let lineHeight = Self.font.ascender - Self.font.descender
      let lines = max(1, text.string.components(separatedBy: "\n").count)
      let top = origin.y + CGFloat(lines - 1) * (lineHeight + Self.font.leading)
      NSRect(
        x: (area.minX + min(caretX, area.width)).rounded(), y: top, width: 2,
        height: lineHeight.rounded()
      ).fill()
    }
  }
}
