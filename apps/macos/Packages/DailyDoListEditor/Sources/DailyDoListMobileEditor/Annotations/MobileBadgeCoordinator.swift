#if canImport(UIKit)
  import DailyDoListEditorCore
  import UIKit

  extension NSAttributedString.Key {
    fileprivate static let mobileBadgePadding = NSAttributedString.Key("ddl.mobileBadgePadding")
  }

  /// Source stays ordinary markdown. Status buttons occupy paragraph spacing below their line,
  /// and the shared anchor model maps them incrementally through edits before the next snapshot.
  @MainActor
  final class MobileBadgeCoordinator {
    weak var owner: MobileMarkdownController?
    var store = BadgeStore()
    private var buttons: [String: UIButton] = [:]
    private var scheduled = false
    private var layingOut = false
    private var paddedStarts: Set<Int> = []

    init(owner: MobileMarkdownController) { self.owner = owner }

    func set(_ badges: [EditorBadge]) {
      guard let owner else { return }
      store.set(
        badges, lineIndex: owner.parser.lineIndex, text: owner.input.textStorage.mutableString)
      schedule()
    }

    func reset() {
      store.removeAll()
      for button in buttons.values { button.removeFromSuperview() }
      buttons.removeAll()
      paddedStarts.removeAll()
    }

    func edited(location: Int, oldLength: Int, newLength: Int) {
      guard let owner else { return }
      // Paragraph attributes move with TextKit's edit. Remap only the small set of decorated lines.
      let end = location + oldLength
      paddedStarts = Set(
        paddedStarts.map { start in
          start < location ? start : start > end ? start + newLength - oldLength : location
        })
      store.applyEdit(
        location: location, oldLength: oldLength, newLength: newLength,
        lineIndex: owner.parser.lineIndex, text: owner.input.textStorage.mutableString)
      schedule()
    }

    func schedule() {
      guard !scheduled else { return }
      scheduled = true
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.scheduled = false
        self.layout()
        self.owner?.input.setNeedsDisplay()
      }
    }

    func layout() {
      guard !layingOut, let owner else { return }
      layingOut = true
      defer { layingOut = false }
      let input = owner.input
      let storage = input.textStorage
      let visible = store.items.filter {
        owner.content.hiddenRange(at: $0.anchor) == nil && !$0.badge.isFading
          && $0.badge.status != "idle" && $0.badge.status != "ignored"
      }
      let groups = Dictionary(grouping: visible, by: \.anchor)
      let height = max(36, UIFont.preferredFont(forTextStyle: .caption1).lineHeight + 16)
      let targets = Set(groups.keys)
      storage.beginEditing()
      for offset in paddedStarts.union(targets) where offset < storage.length {
        let line = owner.parser.lineIndex.line(containing: offset)
        let range = owner.parser.lineIndex.fullRange(ofLine: line, textLength: storage.length)
        guard range.length > 0,
          let existing = storage.attribute(.paragraphStyle, at: range.location, effectiveRange: nil)
            as? NSParagraphStyle,
          let paragraph = existing.mutableCopy() as? NSMutableParagraphStyle
        else { continue }
        let old =
          storage.attribute(.mobileBadgePadding, at: range.location, effectiveRange: nil)
          as? CGFloat ?? 0
        let next = CGFloat(groups[range.location]?.count ?? 0) * (height + 4)
        guard old != next else { continue }
        paragraph.paragraphSpacing = max(0, paragraph.paragraphSpacing - old) + next
        storage.addAttribute(.paragraphStyle, value: paragraph, range: range)
        if next > 0 {
          storage.addAttribute(.mobileBadgePadding, value: next, range: range)
        } else {
          storage.removeAttribute(.mobileBadgePadding, range: range)
        }
      }
      storage.endEditing()
      paddedStarts = targets
      guard input.bounds.width > 0 else { return }
      var shown: Set<String> = []
      let viewport = input.bounds.insetBy(dx: 0, dy: -100)
      for (start, items) in groups where start < storage.length {
        let line = owner.parser.lineIndex.line(containing: start)
        let range = owner.parser.lineIndex.contentRange(ofLine: line, textLength: storage.length)
        guard range.length > 0 else { continue }
        let glyph = input.layoutManager.glyphIndexForCharacter(at: range.end - 1)
        let fragment = input.layoutManager.lineFragmentUsedRect(
          forGlyphAt: glyph, effectiveRange: nil)
        for (index, item) in items.enumerated() {
          let rect = CGRect(
            x: input.textContainerInset.left + 6,
            y: fragment.maxY + input.textContainerInset.top + 2 + CGFloat(index) * (height + 4),
            width: max(
              44,
              input.bounds.width - input.textContainerInset.left - input.textContainerInset.right
                - 12), height: height)
          guard rect.intersects(viewport) else { continue }
          let badge = item.badge
          shown.insert(badge.id)
          let button: UIButton
          if let existing = buttons[badge.id] {
            button = existing
          } else {
            button = UIButton(type: .system)
            button.contentHorizontalAlignment = .leading
            buttons[badge.id] = button
            input.addSubview(button)
          }
          var configuration = UIButton.Configuration.tinted()
          configuration.title = badge.label.isEmpty ? "Orchestrator noticed this line" : badge.label
          configuration.image = UIImage(systemName: symbol(badge.status))
          configuration.imagePadding = 7
          configuration.baseForegroundColor =
            badge.status.contains("approval") || badge.status.contains("needs_you")
            ? .systemOrange : .systemBlue
          configuration.cornerStyle = .medium
          configuration.titleLineBreakMode = .byTruncatingTail
          configuration.contentInsets = NSDirectionalEdgeInsets(
            top: 5, leading: 9, bottom: 5, trailing: 9)
          configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer {
            values in
            var result = values
            result.font = .preferredFont(forTextStyle: .caption1)
            return result
          }
          button.configuration = configuration
          button.frame = rect
          button.accessibilityLabel = [
            configuration.title ?? "", badge.unread > 0 ? "\(badge.unread) unread" : "",
            "Line \(line + 1)",
          ].filter { !$0.isEmpty }.joined(separator: ", ")
          button.accessibilityHint = badge.tooltip ?? "Open conversation"
          button.accessibilityIdentifier = "note.badge.\(badge.id)"
          button.removeAction(identifiedBy: UIAction.Identifier("open"), for: .touchUpInside)
          button.addAction(
            UIAction(identifier: UIAction.Identifier("open")) { [weak owner] _ in
              owner?.onBadgeTap?(badge)
            }, for: .touchUpInside)
        }
      }
      for id in Array(buttons.keys) where !shown.contains(id) {
        buttons.removeValue(forKey: id)?.removeFromSuperview()
      }
    }

    private func symbol(_ status: String) -> String {
      if status.contains("approval") || status.contains("needs_you") || status == "waiting_user" {
        return "exclamationmark.bubble"
      }
      if status.contains("done") { return "checkmark.circle" }
      if status == "failed" { return "exclamationmark.triangle" }
      if status == "cancelled" { return "stop.circle" }
      return "sparkles"
    }
  }
#endif
