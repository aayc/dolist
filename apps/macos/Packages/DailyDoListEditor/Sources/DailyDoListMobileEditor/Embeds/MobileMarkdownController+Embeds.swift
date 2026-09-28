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
      insertEmbed(DrawingEmbed.newDrawing(target: target).markdown)
      return true
    }

    private func insertEmbed(_ markdown: String) {
      let line = parser.lineIndex.line(containing: selection.location)
      let blockEnd =
        content.index.table(at: line)?.last
        ?? content.index.callouts.first(where: { $0.first <= line && $0.last >= line })?.last
      if let blockEnd {
        let offset = parser.lineIndex.fullRange(
          ofLine: blockEnd, textLength: input.textStorage.length
        ).end
        let source = input.textStorage.mutableString
        let prefix = offset > 0 && source.character(at: offset - 1) == 10 ? "\n" : "\n\n"
        perform(
          TextEdit(
            replacements: [
              .init(
                range: NSRange(location: offset, length: 0),
                text: prefix + markdown + "\n\n")
            ], selection: [NSRange(location: offset + prefix.utf16.count, length: 0)]))
      } else {
        let result = EmbedEdits.insert(
          markdown,
          in: input.textStorage.mutableString, caret: selection.location, selection: [selection])
        perform(result.edit)
      }
    }

    /// Resolve dependencies on the checkpoint path, away from input and layout callbacks.
    public static func attachmentTargets(in text: String) -> [String] {
      text.components(separatedBy: "\n").compactMap {
        NoteAttachmentEmbed.parse(line: $0)?.spec.target
      }
    }

    /// Explicit review replaces only matching standalone attachment references, preserving all
    /// surrounding source spelling and placing the complete change in one undo group.
    @discardableResult
    public func replaceAttachment(target: String, with replacement: String) -> Bool {
      guard configuration.isEditable, input.markedTextRange == nil,
        NoteAttachmentEmbed.isSupportedTarget(replacement), !replacement.contains("]]"),
        !replacement.contains("|")
      else { return false }
      let source = input.textStorage.mutableString
      var edits: [TextEdit.Replacement] = []
      for line in parser.attachmentLines {
        let range = parser.lineIndex.contentRange(ofLine: line, textLength: source.length)
        let text = source.substring(with: range)
        if let embed = NoteAttachmentEmbed.parse(line: text), embed.spec.target == target {
          let destination =
            embed.markdown
            ? replacement.addingPercentEncoding(
              withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "()<>"))
            ) ?? replacement
            : replacement
          edits.append(
            .init(range: embed.targetRange.shifted(by: range.location), text: destination))
        }
      }
      guard !edits.isEmpty else { return false }
      perform(TextEdit(replacements: edits, selection: [selection]))
      return true
    }

    @discardableResult
    public func insertAttachment(target: String) -> Bool {
      guard NoteAttachmentEmbed.isSupportedTarget(target), !target.contains("]]"),
        !target.contains("|"),
        configuration.isEditable, input.markedTextRange == nil
      else { return false }
      insertEmbed(DrawingEmbed(target: target).markdown)
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
