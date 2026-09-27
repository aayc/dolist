#if canImport(UIKit)
  import DailyDoListEditorCore
  import DailyDoListMobileDrawing
  import UIKit

  /// Previews live outside the source text. Layout reads cached state only; authenticated loading
  /// and rendering are scheduled after the text system finishes its current transaction.
  @MainActor
  final class MobileEmbedCoordinator {
    weak var owner: MobileMarkdownController?
    var host: MobileEditorEmbedHost?
    private(set) var identity = ""
    private(set) var generation = 0
    private var drawings: [String: EditorDrawingState] = [:]
    private var attachments: [String: MobileEditorAttachmentState] = [:]
    private var previews: [String: MobileAttachmentPreview] = [:]
    private var attachmentOrder: [String] = []
    private var tasks: [String: Task<Void, Never>] = [:]
    private var cards: [Int: MobileEmbedCard] = [:]
    private var dependencies: (Set<String>, Set<String>) = ([], [])
    private var scheduled = false
    private var layingOut = false
    private let drawingPreviews = DrawingPreviewCache(capacity: 12)
    private var naturalSizes: [UInt64: CGSize] = [:]
    private var lastWidth: CGFloat = 0
    var editedLine: Int?
    var editingController: MobileDrawingController?

    struct Item {
      let line: EmbedLine
      let attachment: NoteAttachmentEmbed?
      var isDrawing: Bool { attachment == nil }
    }

    init(owner: MobileMarkdownController) { self.owner = owner }

    func configure(_ host: MobileEditorEmbedHost?, identity: String) {
      guard self.identity != identity || self.host == nil || host == nil else {
        self.host = host
        return
      }
      reset()
      self.identity = identity
      self.host = host
      invalidate()
    }

    func reset() {
      generation += 1
      for task in tasks.values { task.cancel() }
      tasks.removeAll()
      drawings.removeAll()
      attachments.removeAll()
      previews.removeAll()
      attachmentOrder.removeAll()
      drawingPreviews.removeAll()
      naturalSizes.removeAll()
      for card in cards.values { card.removeFromSuperview() }
      cards.removeAll()
      dependencies = ([], [])
      endEditing()
    }

    func refresh(drawings: Bool, attachments: Bool) {
      if drawings {
        self.drawings.removeAll()
        naturalSizes.removeAll()
        drawingPreviews.removeAll()
      }
      if attachments {
        self.attachments.removeAll()
        previews.removeAll()
        attachmentOrder.removeAll()
      }
      generation += 1
      for task in tasks.values { task.cancel() }
      tasks.removeAll()
      invalidate()
    }

    func item(at line: Int) -> Item? {
      guard let owner, line >= 0, line < owner.parser.lineIndex.count else { return nil }
      let text = owner.input.textStorage.mutableString
      let range = owner.parser.lineIndex.contentRange(ofLine: line, textLength: text.length)
      let source = text.substring(with: range)
      if owner.parser.isEmbedLine(line), let spec = DrawingEmbed.parse(line: source) {
        return Item(line: EmbedLine(line: line, content: range, spec: spec), attachment: nil)
      }
      if owner.parser.attachmentLines.contains(line),
        let attachment = NoteAttachmentEmbed.parse(line: source)
      {
        return Item(
          line: EmbedLine(line: line, content: range, spec: attachment.spec), attachment: attachment
        )
      }
      return nil
    }

    func draws(at offset: Int) -> Bool {
      guard let owner, let item = item(at: owner.parser.lineIndex.line(containing: offset)) else {
        return false
      }
      return item.isDrawing ? host?.loadDrawing != nil : host?.loadAttachment != nil
    }

    func fragment(at offset: Int, proposed: CGRect) -> CGRect? {
      guard let owner, let item = item(at: owner.parser.lineIndex.line(containing: offset)),
        item.line.lineStart == offset, draws(at: offset),
        owner.preview.isHidden(.embed, range: item.line.content)
      else { return nil }
      return CGRect(
        x: proposed.minX, y: proposed.minY, width: proposed.width,
        height: size(item).height + 8)
    }

    private var columnWidth: CGFloat {
      guard let input = owner?.input else { return 1 }
      return max(1, input.textContainer.size.width - 2 * input.textContainer.lineFragmentPadding)
    }

    func size(_ item: Item) -> CGSize {
      var spec = item.line.spec
      // Compact columns show floats as blocks without rewriting the original modifiers.
      if spec.placement.wraps, columnWidth < 600 {
        spec.width = nil
        spec.widthPercent = nil
        spec.height = nil
        spec.placement = .full
      }
      let natural: CGSize?
      if let drawing = drawings[spec.target]?.drawing {
        natural = naturalSize(of: drawing)
      } else {
        natural = previews[spec.target]?.naturalSize
      }
      var size = EmbedGeometry.size(for: spec, natural: natural, columnWidth: columnWidth)
      size.height = min(max(100, size.height), 700)
      if editedLine == item.line.lineStart { size.height = max(420, size.height) }
      return size
    }

    func naturalSize(of drawing: EditorDrawing) -> CGSize {
      if let known = naturalSizes[drawing.contentHash] { return known }
      let value = DrawingImage.preferredSize(of: drawing.scene)
      if naturalSizes.count >= 256 { naturalSizes.removeAll() }
      naturalSizes[drawing.contentHash] = value
      return value
    }

    func invalidate() {
      guard let owner else { return }
      for line in owner.parser.embedLines + owner.parser.attachmentLines {
        let range = owner.parser.lineIndex.fullRange(
          ofLine: line, textLength: owner.input.textStorage.length)
        owner.input.layoutManager.invalidateGlyphs(
          forCharacterRange: range, changeInLength: 0, actualCharacterRange: nil)
      }
      schedule()
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

    func layout() {
      guard !layingOut, let owner else { return }
      layingOut = true
      defer { layingOut = false }
      let input = owner.input
      if abs(columnWidth - lastWidth) > 0.5 {
        lastWidth = columnWidth
        invalidate()
      }
      let items = (owner.parser.embedLines + owner.parser.attachmentLines).sorted().compactMap {
        item(at: $0)
      }
      let nextDependencies = (
        Set(items.filter(\.isDrawing).map { $0.line.spec.target }),
        Set(items.filter { !$0.isDrawing }.map { $0.line.spec.target })
      )
      if nextDependencies != dependencies {
        dependencies = nextDependencies
        host?.onDependenciesChanged?(dependencies.0, dependencies.1)
      }
      var visible: Set<Int> = []
      guard owner.configuration.livePreview, input.bounds.width > 0 else {
        for card in cards.values { card.removeFromSuperview() }
        cards.removeAll()
        return
      }
      let viewport = input.bounds.insetBy(dx: 0, dy: -200)
      for item in items {
        let start = item.line.lineStart
        guard draws(at: start), owner.preview.isHidden(.embed, range: item.line.content),
          start < input.textStorage.length
        else { continue }
        let glyph = input.layoutManager.glyphIndexForCharacter(at: start)
        let fragment = input.layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let size = size(item)
        let placement =
          item.line.spec.placement.wraps && columnWidth < 600
          ? DrawingEmbed.Placement.full : item.line.spec.placement
        let rect = CGRect(
          x: input.textContainerInset.left + input.textContainer.lineFragmentPadding
            + EmbedGeometry.x(for: placement, width: size.width, columnWidth: columnWidth),
          y: input.textContainerInset.top + fragment.minY + 4, width: size.width,
          height: size.height)
        guard viewport.intersects(rect) || editedLine == start else { continue }
        visible.insert(start)
        let card = cards[start] ?? MobileEmbedCard(coordinator: self, item: item)
        if cards[start] == nil {
          cards[start] = card
          input.addSubview(card)
        }
        card.item = item
        card.frame = rect
        card.update(
          state: drawingState(item), attachment: attachments[item.line.spec.target],
          preview: previews[item.line.spec.target], cache: drawingPreviews)
        request(item)
      }
      for start in Array(cards.keys) where !visible.contains(start) {
        cards.removeValue(forKey: start)?.removeFromSuperview()
      }
    }

    func drawingState(_ item: Item) -> EditorDrawingState? {
      item.isDrawing ? drawings[item.line.spec.target] ?? .loading : nil
    }

    private func request(_ item: Item) {
      let target = item.line.spec.target
      let key = (item.isDrawing ? "drawing:" : "attachment:") + target
      guard tasks[key] == nil else { return }
      if item.isDrawing, drawings[target] != nil { return }
      if !item.isDrawing, attachments[target] != nil { return }
      let generation = generation
      let identity = identity
      if item.isDrawing, let load = host?.loadDrawing {
        tasks[key] = Task { @MainActor [weak self] in
          let result = await load(target)
          guard let self, !Task.isCancelled, generation == self.generation,
            identity == self.identity
          else { return }
          self.drawings[target] = result
          self.tasks[key] = nil
          self.invalidate()
        }
      } else if let load = host?.loadAttachment {
        tasks[key] = Task { @MainActor [weak self] in
          let result = await load(target)
          var preview: MobileAttachmentPreview?
          if case .ready(let attachment) = result {
            preview = await MobileAttachmentDecoder.shared.preview(attachment, identity: identity)
          }
          guard let self, !Task.isCancelled, generation == self.generation,
            identity == self.identity
          else { return }
          self.storeAttachment(result, preview: preview, target: target)
          self.tasks[key] = nil
          self.invalidate()
        }
      }
    }

    private func storeAttachment(
      _ result: MobileEditorAttachmentState, preview: MobileAttachmentPreview?, target: String
    ) {
      if case .ready(let attachment) = result,
        attachment.data.count > MobileAttachmentDecoder.maximumBytes
      {
        attachments[target] = .unavailable
        return
      }
      attachments[target] = result
      previews[target] = preview
      attachmentOrder.removeAll { $0 == target }
      attachmentOrder.append(target)
      func bytes() -> Int {
        attachments.values.reduce(0) { total, state in
          if case .ready(let attachment) = state { return total + attachment.data.count }
          return total
        }
      }
      func pixels() -> Int {
        previews.values.reduce(0) { $0 + $1.image.bytesPerRow * $1.image.height }
      }
      while attachmentOrder.count > 1
        && (attachmentOrder.count > 12 || bytes() > 32 * 1024 * 1024 || pixels() > 32 * 1024 * 1024)
      {
        let oldest = attachmentOrder.removeFirst()
        attachments.removeValue(forKey: oldest)
        previews.removeValue(forKey: oldest)
      }
    }

    func edit(_ item: Item) {
      guard let owner, owner.configuration.isEditable, item.isDrawing,
        let drawing = drawings[item.line.spec.target]?.drawing,
        let controller = host?.drawingController?(drawing.path)
      else { return }
      endEditing()
      inputResign()
      editedLine = item.line.lineStart
      editingController = controller
      invalidate()
    }

    func endEditing() {
      editingController?.finishEditing()
      for card in cards.values { card.removeEditing() }
      editingController = nil
      editedLine = nil
    }

    private func inputResign() { owner?.input.resignFirstResponder() }

    func open(_ item: Item) {
      if item.isDrawing, let drawing = drawings[item.line.spec.target]?.drawing {
        endEditing()
        invalidate()
        host?.onOpenDrawing?(drawing.path)
      } else if case .ready(let attachment) = attachments[item.line.spec.target] {
        if let open = host?.onOpenAttachment {
          open(attachment)
        } else {
          presentAttachment(attachment)
        }
      }
    }
  }
#endif
