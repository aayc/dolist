#if canImport(UIKit)
  import DailyDoListEditorCore
  import DailyDoListMobileDrawing
  import UIKit

  extension MobileMarkdownController {
    /// Identity must include both the authenticated host and note. Replacing it cancels requests,
    /// disposes inline canvases and prevents previous-host results from entering this document.
    public func setEmbedHost(_ host: MobileEditorEmbedHost?, identity: String) {
      embeds.configure(host, identity: identity)
    }

    public func drawingsDidChange() { embeds.refresh(drawings: true, attachments: false) }
    public func attachmentsDidChange() { embeds.refresh(drawings: false, attachments: true) }
    public func finishEditingDrawing() {
      embeds.endEditing()
      embeds.invalidate()
    }

    @discardableResult
    public func insertDrawing(target: String) -> Bool {
      guard DrawingEmbed.isDrawingTarget(target), !target.contains("\n"), !target.contains("]]"),
        configuration.isEditable, input.markedTextRange == nil
      else { return false }
      let result = EmbedEdits.insert(
        DrawingEmbed.newDrawing(target: target).markdown,
        in: input.textStorage.mutableString, caret: selection.location, selection: [selection])
      perform(result.edit)
      return true
    }

    @discardableResult
    public func insertAttachment(target: String) -> Bool {
      guard NoteAttachmentEmbed.isSupportedTarget(target), !target.contains("]]"),
        !target.contains("|"),
        configuration.isEditable, input.markedTextRange == nil
      else { return false }
      let result = EmbedEdits.insert(
        DrawingEmbed(target: target).markdown,
        in: input.textStorage.mutableString, caret: selection.location, selection: [selection])
      perform(result.edit)
      return true
    }

    /// The insertion happens only after upload acknowledgement, in the same owning note/host.
    @discardableResult
    public func importAttachment(data: Data, filename: String, mimeType: String) async throws
      -> Bool
    {
      guard configuration.isEditable, data.count <= MobileAttachmentDecoder.maximumBytes,
        let upload = embeds.host?.importAttachment
      else { return false }
      let generation = embeds.generation
      let identity = embeds.identity
      let target = try await upload(data, filename, mimeType)
      guard generation == embeds.generation, identity == embeds.identity, !Task.isCancelled else {
        return false
      }
      return insertAttachment(target: target)
    }
  }

  extension MobileEmbedCoordinator {
    private func current(_ item: Item) -> Item? {
      guard let owner, owner.configuration.isEditable, owner.input.markedTextRange == nil,
        let current = self.item(at: item.line.line), current.line == item.line
      else { return nil }
      return current
    }

    func showSource(_ item: Item) {
      guard let owner, let current = self.item(at: item.line.line), current.line == item.line else {
        return
      }
      endEditing()
      owner.selection = item.line.content
      owner.input.becomeFirstResponder()
      owner.input.scrollRangeToVisible(item.line.content)
      owner.updatePreview()
    }

    func remove(_ item: Item) {
      guard current(item) != nil, let owner else { return }
      endEditing()
      owner.perform(
        EmbedEdits.remove(
          item.line, in: owner.input.textStorage.mutableString, selection: [owner.selection]))
    }

    func resize(_ item: Item, width: CGFloat) {
      guard current(item) != nil, item.attachment?.markdown != true, let owner,
        let result = EmbedEdits.resize(
          item.line, width: width,
          in: owner.input.textStorage.mutableString, selection: [owner.selection])
      else { return }
      endEditing()
      owner.perform(result.edit)
    }

    func place(_ item: Item, placement: DrawingEmbed.Placement) {
      guard current(item) != nil, item.attachment?.markdown != true else { return }
      move(item, before: item.line.line, placement: placement)
    }

    func move(_ item: Item, before: Int, placement: DrawingEmbed.Placement? = nil) {
      guard current(item) != nil, let owner else { return }
      if item.attachment?.markdown == true {
        // Markdown attachments retain their original spelling when moved; only wiki syntax has
        // portable size/placement modifiers.
        let text = owner.input.textStorage.mutableString
        let index = owner.parser.lineIndex
        let before = min(max(before, 0), index.count)
        guard before != item.line.line, before != item.line.line + 1 else { return }
        let source = text.substring(with: item.line.content)
        let remove = EmbedEdits.lineRemoval(item.line.content, in: text)
        let offset = before == index.count ? text.length : index.start(ofLine: before)
        let insertion = TextEdit.Replacement(
          range: NSRange(location: offset, length: 0),
          text: before == index.count ? "\n" + source : source + "\n")
        let deletion = TextEdit.Replacement(range: remove, text: "")
        var edit = TextEdit(
          replacements: offset < remove.location ? [insertion, deletion] : [deletion, insertion],
          selection: [])
        edit.selection = [
          NSRange(location: edit.map(owner.selection.location, forward: false), length: 0)
        ]
        owner.perform(edit)
      } else if let result = EmbedEdits.move(
        item.line, before: before,
        placement: placement ?? item.line.spec.placement, in: owner.input.textStorage.mutableString,
        lineIndex: owner.parser.lineIndex, selection: [owner.selection])
      {
        endEditing()
        owner.perform(result.edit)
      }
    }
  }
#endif
