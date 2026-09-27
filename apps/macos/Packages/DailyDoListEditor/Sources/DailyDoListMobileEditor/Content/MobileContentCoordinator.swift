#if canImport(UIKit)
  import DailyDoListEditorCore
  import UIKit

  /// Native content presentation, driven by the controller's existing source/selection lifecycle.
  /// The owner remains the sole text and undo authority; overlays only reveal source rows.
  @MainActor
  final class MobileContentCoordinator {
    weak var owner: MobileMarkdownController?
    var onOpenAgentThread: ((String) -> Void)?
    let index = MarkdownContentIndex()
    private var rows: [Int: MobileTableRowView] = [:]
    private var headers: [Int: MobileCalloutHeaderView] = [:]
    private var backgrounds: [Int: UIView] = [:]
    private var folds: [Int: Bool] = [:]
    private var tableOffsets: [Int: CGFloat] = [:]
    private var scheduled = false
    private var layingOut = false
    private var previousSelection: NSRange?
    private var previousFocus = false
    private var previousWidth: CGFloat = 0
    private var heights: [Int: CGFloat] = [:]
    private var pendingLines: Range<Int>?

    init(owner: MobileMarkdownController) { self.owner = owner }

    func rebuild() {
      guard let owner else { return }
      index.rebuild(owner.input.textStorage.mutableString, literal: owner.parser.isLiteralLine)
      folds.removeAll()
      tableOffsets.removeAll()
      heights.removeAll()
      clearViews()
      invalidate()
    }

    func didEdit(location: Int, oldLength: Int, newLength: Int) {
      guard let owner else { return }
      let oldIndex = index.lineIndex
      let first = oldIndex.line(containing: location)
      let oldLast = oldIndex.line(containing: location + oldLength)
      index.applyEdit(
        location: location, oldLength: oldLength, newLength: newLength,
        text: owner.input.textStorage.mutableString, restyledRange: owner.parser.lastRestyledRange,
        literal: owner.parser.isLiteralLine)
      let shift = index.lineIndex.count - oldIndex.count
      folds = Dictionary(
        uniqueKeysWithValues: folds.compactMap { line, folded in
          if line < first { return (line, folded) }
          if line > oldLast { return (line + shift, folded) }
          return nil
        })
      // No layout or attribute mutation inside NSTextStorage's character-edit notification.
      heights.removeAll()
      if let pendingLines {
        self.pendingLines =
          min(
            pendingLines.lowerBound, index.changedLines.lowerBound)..<max(
            pendingLines.upperBound, index.changedLines.upperBound)
      } else {
        pendingLines = index.changedLines
      }
      schedule()
    }

    func hiddenRange(at offset: Int) -> NSRange? {
      guard let owner, owner.configuration.livePreview, !index.lines.isEmpty else { return nil }
      let line = index.lineIndex.line(containing: offset)
      let range = index.lineIndex.contentRange(
        ofLine: line, textLength: owner.input.textStorage.length)
      if isFolded(line) { return range }
      guard !owner.preview.isLineRevealed(containing: offset) else { return nil }
      return index.table(at: line) != nil || index.lines[line].callout != nil ? range : nil
    }

    func fragment(at offset: Int, proposed: CGRect) -> CGRect? {
      guard hiddenRange(at: offset) != nil else { return nil }
      let line = index.lineIndex.line(containing: offset)
      guard index.lineIndex.start(ofLine: line) == offset else { return nil }
      var rect = proposed
      if isFolded(line) {
        rect.size.height = 0
      } else if let table = index.table(at: line) {
        rect.size.height =
          line == table.first + 1 ? 0 : rowHeight(line, columns: table.alignments.count)
      } else {
        rect.size.height = 44
      }
      return rect
    }

    func schedule() {
      guard !scheduled else { return }
      scheduled = true
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.scheduled = false
        self.layout()
      }
    }

    private var columnWidth: CGFloat {
      guard let input = owner?.input else { return 1 }
      return max(1, input.textContainer.size.width - 2 * input.textContainer.lineFragmentPadding)
    }

    private func isFolded(_ line: Int) -> Bool {
      guard let owner else { return false }
      return index.callouts.contains { block in
        guard line > block.first, line <= block.last,
          let header = index.lines[block.first].callout,
          folds[block.first] ?? header.fold ?? false
        else { return false }
        if owner.input.isFirstResponder {
          if selection(owner.selection, touchesBodyOf: block) { return false }
        }
        return true
      }
    }

    func rowHeight(_ line: Int, columns: Int) -> CGFloat {
      if let cached = heights[line] { return cached }
      guard let owner else { return 44 }
      let width = max(110, columnWidth / CGFloat(max(1, columns)))
      let cells = cells(at: line, columns: columns)
      let style = MobileMarkdownStyle(fontSize: owner.configuration.fontSize)
      let height = cells.reduce(CGFloat(40)) { previous, cell in
        let text = style.contentText(cell.source)
        let size = text.boundingRect(
          with: CGSize(width: width - 20, height: 1000),
          options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        return max(previous, min(1000, ceil(size.height) + 20))
      }
      heights[line] = height
      return height
    }

    func cells(at line: Int, columns: Int) -> [MarkdownContentLine.Cell] {
      guard let owner else { return [] }
      if let cells = index.lines[line].cells { return Array(cells.prefix(columns)) }
      let range = index.lineIndex.contentRange(
        ofLine: line, textLength: owner.input.textStorage.length)
      let descriptor = index.lines[line]
      let end = descriptor.agent?.range.location ?? range.length
      let cellRange = NSRange(descriptor.bodyStart, max(descriptor.bodyStart, end))
      let source = owner.input.textStorage.mutableString.substring(
        with: NSRange(location: range.location + cellRange.location, length: cellRange.length))
      return [MarkdownContentLine.Cell(source: source, range: cellRange)]
    }

    func layout() {
      guard !layingOut, let owner, !index.lines.isEmpty else { return }
      layingOut = true
      defer { layingOut = false }
      let input = owner.input
      guard owner.configuration.livePreview else {
        clearViews()
        return
      }
      if previousWidth != columnWidth {
        previousWidth = columnWidth
        heights.removeAll()
        invalidate()
      } else if let pendingLines {
        invalidate(lines: pendingLines)
      }
      pendingLines = nil
      // The ordinary preview lifecycle already invalidates the old/new source row. Moving into
      // a folded body additionally changes the whole callout's visibility, but not other blocks.
      if previousSelection != owner.selection || previousFocus != input.isFirstResponder {
        for block in index.callouts where index.lines[block.first].callout?.fold != nil {
          let wasInside = previousFocus && selection(previousSelection, touchesBodyOf: block)
          let isInside = input.isFirstResponder && selection(owner.selection, touchesBodyOf: block)
          if wasInside != isInside { invalidate(lines: block.first..<(block.last + 1)) }
        }
        previousSelection = owner.selection
        previousFocus = input.isFirstResponder
      }
      let visible = input.bounds.insetBy(dx: 0, dy: -100)
      let textBounds = visible.offsetBy(
        dx: -input.textContainerInset.left, dy: -input.textContainerInset.top)
      let glyphRange = input.layoutManager.glyphRange(
        forBoundingRect: textBounds, in: input.textContainer)
      let characters = input.layoutManager.characterRange(
        forGlyphRange: glyphRange, actualGlyphRange: nil)
      let firstVisible = index.lineIndex.line(containing: characters.location)
      let lastVisible = index.lineIndex.line(
        containing: max(characters.location, characters.end - 1))
      var activeRows: Set<Int> = []
      var activeHeaders: Set<Int> = []
      var activeBackgrounds: Set<Int> = []
      for table in index.tables where table.last >= firstVisible && table.first <= lastVisible {
        for line in max(table.first, firstVisible)...min(table.last, lastVisible)
        where line != table.first + 1 {
          let offset = index.lineIndex.start(ofLine: line)
          guard !isFolded(line), hiddenRange(at: offset) != nil, let rect = lineRect(line),
            rect.intersects(visible)
          else { continue }
          activeRows.insert(line)
          let row = rows[line] ?? MobileTableRowView(coordinator: self)
          if rows[line] == nil {
            rows[line] = row
            input.addSubview(row)
          }
          row.frame = rect
          row.configure(
            line: line, table: table, width: columnWidth, offset: tableOffsets[table.first] ?? 0)
        }
      }
      for block in index.callouts where block.last >= firstVisible && block.first <= lastVisible {
        guard !isFolded(block.first), let descriptor = index.lines[block.first].callout,
          let firstRect = lineRect(max(block.first, firstVisible)),
          let lastRect = lineRect(min(block.last, lastVisible))
        else { continue }
        let box = CGRect(
          x: firstRect.minX, y: firstRect.minY, width: columnWidth,
          height: max(44, lastRect.maxY - firstRect.minY))
        if box.intersects(visible) {
          activeBackgrounds.insert(block.first)
          let background = backgrounds[block.first] ?? UIView()
          if backgrounds[block.first] == nil {
            backgrounds[block.first] = background
            background.isUserInteractionEnabled = false
            background.layer.cornerRadius = 8
            input.insertSubview(background, at: 0)
          }
          background.frame = box.insetBy(dx: CGFloat(max(0, descriptor.depth - 1)) * 6, dy: 0)
          background.backgroundColor = MobileMarkdownStyle.calloutColor(descriptor.family)
            .withAlphaComponent(0.07)
          background.layer.borderColor =
            MobileMarkdownStyle.calloutColor(descriptor.family).withAlphaComponent(0.25).cgColor
          background.layer.borderWidth = 1
        }
        guard block.first >= firstVisible,
          hiddenRange(at: index.lineIndex.start(ofLine: block.first)) != nil,
          firstRect.intersects(visible)
        else { continue }
        activeHeaders.insert(block.first)
        let header = headers[block.first] ?? MobileCalloutHeaderView(coordinator: self)
        if headers[block.first] == nil {
          headers[block.first] = header
          input.addSubview(header)
        }
        header.frame = firstRect
        header.configure(
          line: block.first, header: descriptor,
          folded: folds[block.first] ?? descriptor.fold ?? false)
      }
      for line in Array(rows.keys) where !activeRows.contains(line) {
        rows.removeValue(forKey: line)?.removeFromSuperview()
      }
      for line in Array(headers.keys) where !activeHeaders.contains(line) {
        headers.removeValue(forKey: line)?.removeFromSuperview()
      }
      for line in Array(backgrounds.keys) where !activeBackgrounds.contains(line) {
        backgrounds.removeValue(forKey: line)?.removeFromSuperview()
      }
    }

    private func lineRect(_ line: Int) -> CGRect? {
      guard let input = owner?.input else { return nil }
      let start = index.lineIndex.start(ofLine: line)
      guard start < input.textStorage.length else { return nil }
      let glyph = input.layoutManager.glyphIndexForCharacter(at: start)
      let fragment = input.layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
      return CGRect(
        x: input.textContainerInset.left + input.textContainer.lineFragmentPadding,
        y: input.textContainerInset.top + fragment.minY, width: columnWidth, height: fragment.height
      )
    }

    func reveal(line: Int, cell: MarkdownContentLine.Cell? = nil) {
      guard let owner else { return }
      let offset = index.lineIndex.start(ofLine: line)
      owner.selection = NSRange(
        location: offset + (cell?.range.location ?? 0), length: cell?.range.length ?? 0)
      owner.input.becomeFirstResponder()
      owner.updatePreview()
      owner.input.scrollRangeToVisible(owner.selection)
      invalidate(lines: line..<(line + 1))
    }

    func toggleCallout(_ line: Int) {
      guard index.lines.indices.contains(line), let callout = index.lines[line].callout,
        callout.fold != nil
      else { return }
      folds[line] = !(folds[line] ?? callout.fold ?? false)
      owner?.input.resignFirstResponder()
      owner?.updatePreview()
      if let block = index.callouts.first(where: { $0.first == line }) {
        invalidate(lines: block.first..<(block.last + 1))
      }
    }

    func scrollTable(_ table: Int, offset: CGFloat, sender: MobileTableRowView) {
      tableOffsets[table] = offset
      for row in rows.values where row !== sender && row.tableStart == table {
        row.setOffset(offset)
      }
    }

    private func selection(_ selection: NSRange?, touchesBodyOf block: MarkdownContentIndex.Callout)
      -> Bool
    {
      guard let selection else { return false }
      let first = index.lineIndex.line(containing: selection.location)
      let last = index.lineIndex.line(containing: selection.end)
      return last > block.first && first <= block.last
    }

    private func invalidate() {
      for table in index.tables { invalidate(lines: table.first..<(table.last + 1)) }
      for block in index.callouts { invalidate(lines: block.first..<(block.last + 1)) }
      schedule()
    }

    private func invalidate(lines: Range<Int>) {
      guard let owner, !lines.isEmpty, lines.lowerBound < index.lines.count else { return }
      let start = index.lineIndex.start(ofLine: max(0, lines.lowerBound))
      let end = index.lineIndex.fullRange(
        ofLine: min(index.lines.count - 1, lines.upperBound - 1),
        textLength: owner.input.textStorage.length
      ).end
      owner.input.layoutManager.invalidateGlyphs(
        forCharacterRange: NSRange(start, end), changeInLength: 0, actualCharacterRange: nil)
      schedule()
    }

    private func clearViews() {
      for view in rows.values { view.removeFromSuperview() }
      for view in headers.values { view.removeFromSuperview() }
      for view in backgrounds.values { view.removeFromSuperview() }
      rows.removeAll()
      headers.removeAll()
      backgrounds.removeAll()
    }
  }
#endif
