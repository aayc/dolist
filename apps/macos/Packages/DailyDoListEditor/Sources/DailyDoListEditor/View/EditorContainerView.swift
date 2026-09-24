import AppKit

/// The editor's outer view: the scroll view, with vim's command-line panel under it while vim
/// shows one (the scroll view gets shorter, like CodeMirror's bottom panels).
final class EditorContainerView: NSView {
  let scrollView: NSScrollView
  private(set) var panel: NSView?
  /// False keeps the editor's size while a panel shows (the panel is kept but not laid out): the
  /// vim vector replay pins the oracle's viewport, whose messages don't take room.
  var showsPanel = true

  init(scrollView: NSScrollView) {
    self.scrollView = scrollView
    super.init(frame: scrollView.frame)
    scrollView.autoresizingMask = []
    addSubview(scrollView)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override var isFlipped: Bool { true }

  /// Shows `panel` under the editor (nil removes it). The panel sizes itself (`fittingHeight`).
  func setPanel(_ panel: NSView?) {
    guard panel !== self.panel else {
      needsLayout = true
      return
    }
    self.panel?.removeFromSuperview()
    self.panel = panel
    if let panel { addSubview(panel) }
    needsLayout = true
    layoutSubtreeIfNeeded()
  }

  override func layout() {
    super.layout()
    var panelHeight: CGFloat = 0
    if showsPanel, let panel = panel as? VimPanelView {
      panelHeight = min(panel.fittingHeight(forWidth: bounds.width), (bounds.height * 0.5).rounded(.down))
      panel.frame = NSRect(x: 0, y: bounds.height - panelHeight, width: bounds.width, height: panelHeight)
    }
    let scrollFrame = NSRect(x: 0, y: 0, width: bounds.width, height: max(0, bounds.height - panelHeight))
    if scrollView.frame != scrollFrame { scrollView.frame = scrollFrame }
  }

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    needsLayout = true
    layoutSubtreeIfNeeded()
  }
}
