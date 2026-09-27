#if canImport(UIKit)
  import DailyDoListEditorCore
  import UIKit

  @MainActor final class MobileTableRowView: UIScrollView, UIScrollViewDelegate {
    weak var coordinator: MobileContentCoordinator?
    private(set) var tableStart = 0
    private var buttons: [UIButton] = []
    private var settingOffset = false
    init(coordinator: MobileContentCoordinator) {
      self.coordinator = coordinator
      super.init(frame: .zero)
      delegate = self
      showsHorizontalScrollIndicator = true
      alwaysBounceVertical = false
      isDirectionalLockEnabled = true
      layer.borderWidth = 0.5
      layer.borderColor = UIColor.separator.cgColor
      accessibilityIdentifier = "note.table.row"
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("Use init") }

    func configure(line: Int, table: MarkdownContentIndex.Table, width: CGFloat, offset: CGFloat) {
      guard let coordinator, let owner = coordinator.owner else { return }
      tableStart = table.first
      let columns = table.alignments.count
      let cells = coordinator.cells(at: line, columns: columns)
      let cellWidth = max(110, width / CGFloat(max(1, columns)))
      let style = MobileMarkdownStyle(fontSize: owner.configuration.fontSize)
      while buttons.count < columns {
        let button = UIButton(type: .system)
        button.titleLabel?.numberOfLines = 0
        button.contentVerticalAlignment = .center
        button.layer.borderWidth = 0.25
        button.layer.borderColor = UIColor.separator.cgColor
        buttons.append(button)
        addSubview(button)
      }
      while buttons.count > columns { buttons.removeLast().removeFromSuperview() }
      for column in 0..<columns {
        let button = buttons[column]
        let cell = cells.indices.contains(column) ? cells[column] : nil
        button.frame = CGRect(
          x: CGFloat(column) * cellWidth, y: 0, width: cellWidth, height: bounds.height)
        button.backgroundColor =
          line == table.first ? .tertiarySystemFill : .secondarySystemBackground
        var configuration = UIButton.Configuration.plain()
        configuration.contentInsets = NSDirectionalEdgeInsets(
          top: 8, leading: 10, bottom: 8, trailing: 10)
        button.configuration = configuration
        let authored = coordinator.index.lines[line].agent
        let text = NSMutableAttributedString(
          attributedString: style.contentText(cell?.source ?? "", bold: line == table.first))
        if authored != nil {
          text.addAttribute(
            .foregroundColor, value: UIColor.systemBlue,
            range: NSRange(location: 0, length: text.length))
          if column == 0 {
            text.insert(
              NSAttributedString(string: "✦ ", attributes: [.foregroundColor: UIColor.systemBlue]),
              at: 0)
          }
        }
        if let thread = authored?.threadId, coordinator.onOpenAgentThread != nil {
          button.menu = UIMenu(children: [
            UIAction(title: "Open agent thread") { [weak coordinator] _ in
              coordinator?.onOpenAgentThread?(thread)
            }
          ])
        } else {
          button.menu = nil
        }
        button.setAttributedTitle(text, for: .normal)
        switch table.alignments[column] {
        case .left:
          button.contentHorizontalAlignment = .left
          button.titleLabel?.textAlignment = .left
        case .center:
          button.contentHorizontalAlignment = .center
          button.titleLabel?.textAlignment = .center
        case .right:
          button.contentHorizontalAlignment = .right
          button.titleLabel?.textAlignment = .right
        }
        button.accessibilityLabel =
          "\(line == table.first ? "Header" : "Row \(line - table.first)"), column \(column + 1): \(text.string)"
        button.accessibilityHint = "Show the source row"
        button.removeTarget(nil, action: nil, for: .allEvents)
        button.removeAction(identifiedBy: UIAction.Identifier("reveal"), for: .touchUpInside)
        button.addAction(
          UIAction(identifier: UIAction.Identifier("reveal")) { [weak coordinator] _ in
            coordinator?.reveal(line: line, cell: cell)
          }, for: .touchUpInside)
      }
      contentSize = CGSize(width: cellWidth * CGFloat(columns), height: bounds.height)
      setOffset(offset)
    }
    func setOffset(_ offset: CGFloat) {
      settingOffset = true
      setContentOffset(
        CGPoint(x: min(max(0, offset), max(0, contentSize.width - bounds.width)), y: 0),
        animated: false)
      settingOffset = false
    }
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
      if !settingOffset {
        coordinator?.scrollTable(tableStart, offset: contentOffset.x, sender: self)
      }
    }
  }
#endif
