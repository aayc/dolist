#if canImport(UIKit)
  import DailyDoListEditorCore
  import UIKit

  @MainActor final class MobileCalloutHeaderView: UIView {
    weak var coordinator: MobileContentCoordinator?
    private let title = UIButton(type: .system)
    private let fold = UIButton(type: .system)
    private var line = 0
    init(coordinator: MobileContentCoordinator) {
      self.coordinator = coordinator
      super.init(frame: .zero)
      title.contentHorizontalAlignment = .leading
      title.titleLabel?.lineBreakMode = .byTruncatingTail
      title.addAction(
        UIAction { [weak self] _ in
          guard let self else { return }
          self.coordinator?.reveal(line: self.line)
        }, for: .touchUpInside)
      fold.addAction(
        UIAction { [weak self] _ in
          guard let self else { return }
          self.coordinator?.toggleCallout(self.line)
        }, for: .touchUpInside)
      addSubview(title)
      addSubview(fold)
      accessibilityIdentifier = "note.callout.header"
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("Use init") }
    override func layoutSubviews() {
      super.layoutSubviews()
      title.frame = CGRect(x: 10, y: 0, width: max(0, bounds.width - 54), height: bounds.height)
      fold.frame = CGRect(x: bounds.width - 44, y: 0, width: 44, height: bounds.height)
    }
    func configure(line: Int, header: MarkdownContentLine.Callout, folded: Bool) {
      self.line = line
      let color = MobileMarkdownStyle.calloutColor(header.family)
      backgroundColor = color.withAlphaComponent(0.12)
      let style = MobileMarkdownStyle(fontSize: coordinator?.owner?.configuration.fontSize ?? 16)
      let text = NSMutableAttributedString(
        attributedString: style.contentText(header.title, bold: true))
      let agent = coordinator?.index.lines[line].agent
      if agent != nil {
        text.insert(
          NSAttributedString(string: "✦ ", attributes: [.foregroundColor: UIColor.systemBlue]),
          at: 0)
      }
      title.setAttributedTitle(text, for: .normal)
      if let thread = agent?.threadId, coordinator?.onOpenAgentThread != nil {
        title.menu = UIMenu(children: [
          UIAction(title: "Open agent thread") { [weak coordinator] _ in
            coordinator?.onOpenAgentThread?(thread)
          }
        ])
      } else {
        title.menu = nil
      }
      title.setImage(
        UIImage(systemName: MobileMarkdownStyle.calloutSymbol(header.family)), for: .normal)
      title.tintColor = color
      title.accessibilityLabel =
        "\(agent == nil ? "" : "Agent-authored ")\(header.type.capitalized): \(header.title)"
      title.accessibilityHint = "Show callout source"
      fold.isHidden = header.fold == nil
      fold.setImage(UIImage(systemName: folded ? "chevron.right" : "chevron.down"), for: .normal)
      fold.tintColor = color
      fold.accessibilityLabel = folded ? "Expand callout" : "Collapse callout"
    }
  }
#endif
