#if canImport(UIKit)
  import CoreText
  import UIKit

  extension MobileDrawingCanvasView: UITextViewDelegate {
    func beginInlineTextEditing(_ id: String) {
      endInlineTextEditing(notify: false)
      guard let element = editor.element(id), let text = element.text else { return }
      let input = UITextView()
      input.backgroundColor = .clear
      input.isScrollEnabled = false
      input.textContainerInset = .zero
      input.textContainer.lineFragmentPadding = 0
      input.autocorrectionType = .no
      input.smartDashesType = .no
      input.smartQuotesType = .no
      input.text = text.originalText
      input.accessibilityLabel = "Drawing text"
      let toolbar = UIToolbar()
      toolbar.items = [
        UIBarButtonItem(systemItem: .flexibleSpace),
        UIBarButtonItem(title: "Done", style: .done, target: self, action: #selector(finishText)),
      ]
      toolbar.sizeToFit()
      input.inputAccessoryView = toolbar
      input.delegate = self
      textEditor = input
      textElementId = id
      addSubview(input)
      positionTextEditor()
      input.becomeFirstResponder()
      input.selectedRange = NSRange(location: 0, length: input.text.utf16.count)
    }

    @objc private func finishText() { endInlineTextEditing() }

    public func endInlineTextEditing(notify: Bool = true) {
      guard let input = textEditor else { return }
      textEditor = nil
      textElementId = nil
      input.delegate = nil
      input.resignFirstResponder()
      input.removeFromSuperview()
      if notify { editor.endTextEditing() }
      setNeedsDisplay()
    }

    public func textViewDidChange(_ textView: UITextView) {
      editor.updateEditingText(textView.text)
      positionTextEditor()
    }

    public func textViewDidEndEditing(_ textView: UITextView) {
      if textEditor === textView { endInlineTextEditing() }
    }

    func positionTextEditor() {
      guard let input = textEditor, let id = textElementId,
        let element = editor.element(id), let text = element.text
      else { return }
      let font =
        DrawingFonts.font(family: text.fontFamily, size: text.fontSize * viewport.zoom) as UIFont
      input.font = font
      input.textColor = UIColor(
        cgColor: DrawingColorCache.shared.cgColor(element.strokeColor, theme: theme))
      input.textAlignment =
        text.textAlign == .center ? .center : text.textAlign == .right ? .right : .left
      let width: Double
      let x: Double
      if let containerId = element.containerId, let container = editor.element(containerId),
        container.type != .arrow
      {
        width = DrawingEditor.boundTextMaxWidth(container)
        x = container.x + (container.width - width) / 2
      } else {
        width = max(element.width, text.fontSize) + text.fontSize
        x = element.x
      }
      let origin = viewport.sceneToView(DrawingPoint(x, element.y))
      input.transform = .identity
      input.frame = CGRect(
        x: origin.x, y: origin.y, width: max(44, width * viewport.zoom),
        height: max(44, max(element.height, text.lineHeightPx) * viewport.zoom + 8))
      input.transform = CGAffineTransform(rotationAngle: element.angle)
    }
  }
#endif
