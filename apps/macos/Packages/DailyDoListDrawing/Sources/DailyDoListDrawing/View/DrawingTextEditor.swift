import AppKit

/// The inline editor for a text element: a borderless text view over the element, in its font,
/// color and alignment at the canvas's zoom. Return adds a line; Escape, ⌘Return or a click
/// elsewhere finishes (Excalidraw's keys).
@MainActor
final class DrawingTextEditor: NSTextView {
  var elementId: String = ""
  var onTextChange: ((String) -> Void)?
  var onFinish: (() -> Void)?

  override func keyDown(with event: NSEvent) {
    if event.keyCode == 53
      || (event.keyCode == 36 || event.keyCode == 76) && event.modifierFlags.contains(.command)
    {
      onFinish?()
      return
    }
    super.keyDown(with: event)
  }

  override func didChangeText() {
    super.didChangeText()
    onTextChange?(string)
  }

  override func resignFirstResponder() -> Bool {
    let resigned = super.resignFirstResponder()
    if resigned { DispatchQueue.main.async { [weak self] in self?.onFinish?() } }
    return resigned
  }
}

extension DrawingCanvasView {
  func beginInlineTextEditing(_ id: String) {
    endInlineTextEditing(notify: false)
    guard let element = editor.element(id), element.text != nil else { return }
    let textView = DrawingTextEditor(frame: .zero)
    textView.elementId = id
    textView.drawsBackground = false
    textView.isRichText = false
    textView.allowsUndo = true
    textView.isAutomaticQuoteSubstitutionEnabled = false
    textView.isAutomaticDashSubstitutionEnabled = false
    textView.isAutomaticTextReplacementEnabled = false
    textView.isAutomaticSpellingCorrectionEnabled = false
    textView.textContainerInset = .zero
    textView.textContainer?.lineFragmentPadding = 0
    textView.textContainer?.widthTracksTextView = false
    textView.isHorizontallyResizable = false
    textView.isVerticallyResizable = false
    textView.string = element.text?.originalText ?? ""
    textView.onTextChange = { [weak self] text in
      self?.editor.updateEditingText(text)
    }
    textView.onFinish = { [weak self] in
      guard let self, self.textEditor === textView else { return }
      self.endInlineTextEditing()
    }
    addSubview(textView)
    textEditor = textView
    styleTextEditor()
    positionTextEditor()
    window?.makeFirstResponder(textView)
    textView.selectAll(nil)
    needsDisplay = true
  }

  /// Finishes inline editing (commits through the editor unless `notify` is false).
  func endInlineTextEditing(notify: Bool = true) {
    guard let textView = textEditor else { return }
    textEditor = nil
    textView.onFinish = nil
    textView.onTextChange = nil
    textView.removeFromSuperview()
    if notify, editor.editingTextId != nil { editor.endTextEditing() }
    if window?.firstResponder == nil || window?.firstResponder === textView {
      window?.makeFirstResponder(self)
    }
    needsDisplay = true
  }

  func styleTextEditor() {
    guard let textView = textEditor, let element = editor.element(textView.elementId),
      let text = element.text
    else { return }
    let size = text.fontSize * viewport.zoom
    let font = DrawingFonts.font(family: text.fontFamily, size: size) as NSFont
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment =
      text.textAlign == .center ? .center : text.textAlign == .right ? .right : .left
    let lineHeight = text.lineHeightPx * viewport.zoom
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    let metrics = FontFamily.metrics(text.fontFamily)
    let baseline = metrics.verticalOffset(fontSize: size, lineHeightPx: lineHeight)
    let color =
      NSColor(cgColor: DrawingColorCache.shared.cgColor(element.strokeColor, theme: theme))
      ?? .textColor
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font, .foregroundColor: color, .paragraphStyle: paragraph,
      .baselineOffset: lineHeight - baseline - CTFontGetDescent(font),
    ]
    textView.typingAttributes = attributes
    textView.textStorage?.setAttributes(
      attributes, range: NSRange(location: 0, length: textView.string.utf16.count))
    textView.insertionPointColor = color
    textView.alignment = paragraph.alignment
  }

  /// Keeps the editor over its element as the text grows, the canvas pans or zooms.
  func positionTextEditor() {
    guard let textView = textEditor, let element = editor.element(textView.elementId),
      let text = element.text
    else { return }
    let lineHeight = text.lineHeightPx
    var width = max(element.width, text.fontSize) + text.fontSize
    var x = element.x
    if let containerId = text.containerId, let container = editor.element(containerId),
      container.type != .arrow
    {
      width = DrawingEditor.boundTextMaxWidth(container)
      x = container.x + (container.width - width) / 2
    } else if text.textAlign == .center {
      x = element.x - text.fontSize / 2
    }
    let origin = viewport.sceneToView(DrawingPoint(x, element.y))
    let frame = CGRect(
      x: origin.x, y: origin.y, width: width * viewport.zoom,
      height: max(element.height, lineHeight) * viewport.zoom + 2)
    if textView.frame != frame {
      textView.frame = frame
      textView.textContainer?.containerSize = CGSize(
        width: frame.width, height: .greatestFiniteMagnitude)
      styleTextEditor()
    }
  }
}
