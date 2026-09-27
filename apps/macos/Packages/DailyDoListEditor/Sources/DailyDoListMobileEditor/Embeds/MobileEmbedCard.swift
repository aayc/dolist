#if canImport(UIKit)
  import DailyDoListEditorCore
  import DailyDoListMobileDrawing
  import SwiftUI
  import UIKit

  @MainActor
  final class MobileEmbedCard: UIView {
    weak var coordinator: MobileEmbedCoordinator?
    var item: MobileEmbedCoordinator.Item
    private let image = UIImageView()
    private let message = UILabel()
    private let title = UIButton(type: .system)
    private let menu = UIButton(type: .system)
    private let resize = UIButton(type: .system)
    private var hosted: UIHostingController<MobileDrawingView>?
    private var originalFrame: CGRect?
    private var moveStart: CGPoint?

    init(coordinator: MobileEmbedCoordinator, item: MobileEmbedCoordinator.Item) {
      self.coordinator = coordinator
      self.item = item
      super.init(frame: .zero)
      backgroundColor = .secondarySystemBackground
      layer.cornerRadius = 8
      layer.borderWidth = 1
      layer.borderColor = UIColor.separator.cgColor
      clipsToBounds = true
      image.contentMode = .scaleAspectFit
      image.isUserInteractionEnabled = true
      image.addGestureRecognizer(
        UITapGestureRecognizer(target: self, action: #selector(openPreview)))
      message.textAlignment = .center
      message.numberOfLines = 3
      message.font = .preferredFont(forTextStyle: .caption1)
      message.textColor = .secondaryLabel
      title.titleLabel?.font = .preferredFont(forTextStyle: .caption1)
      title.contentHorizontalAlignment = .leading
      title.addAction(
        UIAction { [weak self] _ in
          guard let self else { return }
          self.coordinator?.open(self.item)
        }, for: .touchUpInside)
      title.addGestureRecognizer(
        UILongPressGestureRecognizer(target: self, action: #selector(moveGesture(_:))))
      menu.setImage(UIImage(systemName: "ellipsis.circle"), for: .normal)
      menu.accessibilityLabel = "Embed actions"
      menu.showsMenuAsPrimaryAction = true
      resize.setImage(UIImage(systemName: "arrow.up.left.and.arrow.down.right"), for: .normal)
      resize.accessibilityLabel = "Resize embed"
      resize.addGestureRecognizer(
        UIPanGestureRecognizer(target: self, action: #selector(resizeGesture(_:))))
      for view in [image, message, title, menu, resize] { addSubview(view) }
      accessibilityIdentifier = "note.embed"
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("Use init") }

    override func layoutSubviews() {
      super.layoutSubviews()
      let body = CGRect(
        x: 8, y: 8, width: max(1, bounds.width - 16), height: max(1, bounds.height - 52))
      image.frame = body
      message.frame = body
      hosted?.view.frame = CGRect(
        x: 0, y: 0, width: bounds.width, height: max(1, bounds.height - 44))
      title.frame = CGRect(
        x: 10, y: bounds.height - 44, width: max(0, bounds.width - 100), height: 44)
      menu.frame = CGRect(x: bounds.width - 88, y: bounds.height - 44, width: 44, height: 44)
      resize.frame = CGRect(x: bounds.width - 44, y: bounds.height - 44, width: 44, height: 44)
    }

    func update(
      state: EditorDrawingState?, attachment: MobileEditorAttachmentState?,
      preview: MobileAttachmentPreview?, cache: DrawingPreviewCache
    ) {
      let editable = coordinator?.owner?.configuration.isEditable == true
      title.setTitle(
        item.line.spec.alias ?? (item.line.spec.target as NSString).lastPathComponent, for: .normal)
      title.accessibilityHint = "Open preview. Touch and hold to move."
      resize.isHidden = !editable || item.attachment?.markdown == true
      image.image = nil
      message.text = nil
      if let state {
        switch state {
        case .loading: message.text = "Loading drawing…"
        case .missing: message.text = "Drawing not found"
        case .unreadable: message.text = "Drawing unavailable"
        case .ready(let drawing):
          if drawing.scene.visibleElements.isEmpty {
            message.text = "Empty drawing"
          } else {
            let natural = coordinator?.naturalSize(of: drawing) ?? CGSize(width: 1, height: 1)
            let scaleWidth = min(
              max(1, bounds.width - 16), 1000 * natural.width / max(1, natural.height))
            if let cg = cache.image(
              for: drawing.scene, contentHash: drawing.contentHash, width: Double(scaleWidth),
              displayScale: min(2, traitCollection.displayScale),
              theme: traitCollection.userInterfaceStyle == .dark ? .dark : .light,
              background: .transparent)
            {
              image.image = UIImage(cgImage: cg)
            }
          }
        }
      } else if let preview {
        image.image = UIImage(cgImage: preview.image)
      } else {
        switch attachment {
        case .missing: message.text = "Attachment not found"
        case .unavailable: message.text = "Attachment unavailable"
        case .ready: message.text = "Preview unavailable. Open or save the original file."
        case nil: message.text = "Loading attachment…"
        }
      }
      updateEditing()
      menu.menu = actions(editable: editable)
    }

    private func updateEditing() {
      guard let coordinator, coordinator.editedLine == item.line.lineStart,
        let controller = coordinator.editingController
      else {
        removeEditing()
        return
      }
      guard hosted == nil else { return }
      let hosted = UIHostingController(rootView: MobileDrawingView(controller: controller))
      coordinator.owner?.input.owningViewController?.addChild(hosted)
      addSubview(hosted.view)
      hosted.didMove(toParent: hosted.parent)
      self.hosted = hosted
      setNeedsLayout()
    }

    func removeEditing() {
      guard let hosted else { return }
      hosted.willMove(toParent: nil)
      hosted.view.removeFromSuperview()
      hosted.removeFromParent()
      self.hosted = nil
    }

    override func removeFromSuperview() {
      removeEditing()
      super.removeFromSuperview()
    }

    private func actions(editable: Bool) -> UIMenu {
      func action(
        _ title: String,
        _ callback:
          @escaping @MainActor (MobileEmbedCoordinator, MobileEmbedCoordinator.Item) -> Void
      ) -> UIAction {
        UIAction(title: title) { [weak self] _ in
          guard let self, let coordinator = self.coordinator else { return }
          callback(coordinator, self.item)
        }
      }
      var commands: [UIMenuElement] = [
        action(item.isDrawing ? "Open drawing" : "Open attachment") { $0.open($1) },
        action("Show source") { $0.showSource($1) },
      ]
      if coordinator?.editedLine == item.line.lineStart {
        commands.append(
          action("Done editing") { coordinator, _ in
            coordinator.endEditing()
            coordinator.invalidate()
          })
      } else if editable, item.isDrawing, coordinator?.host?.drawingController != nil {
        commands.append(action("Edit here") { $0.edit($1) })
      }
      if editable {
        commands += [
          action("Move up") { $0.move($1, before: $1.line.line - 1) },
          action("Move down") { $0.move($1, before: $1.line.line + 2) },
        ]
        if item.attachment?.markdown != true {
          commands.append(
            UIMenu(
              title: "Placement",
              children: DrawingEmbed.Placement.allCases.map { placement in
                action(placement.rawValue) { $0.place($1, placement: placement) }
              }))
          commands.append(
            action("Smaller") { coordinator, item in
              coordinator.resize(item, width: coordinator.size(item).width * 0.8)
            })
          commands.append(
            action("Larger") { coordinator, item in
              coordinator.resize(item, width: coordinator.size(item).width * 1.25)
            })
        }
        let remove = action("Remove embed") { $0.remove($1) }
        remove.attributes = .destructive
        commands.append(remove)
      }
      return UIMenu(children: commands)
    }

    @objc private func openPreview() { coordinator?.open(item) }

    @objc private func resizeGesture(_ gesture: UIPanGestureRecognizer) {
      guard let coordinator, coordinator.owner?.configuration.isEditable == true else { return }
      switch gesture.state {
      case .began: originalFrame = frame
      case .changed:
        guard let originalFrame else { return }
        let width = max(48, originalFrame.width + gesture.translation(in: superview).x)
        frame.size = CGSize(width: width, height: originalFrame.height)
      case .ended:
        let width = frame.width
        originalFrame = nil
        coordinator.resize(item, width: width)
        coordinator.invalidate()
      default:
        if let originalFrame { frame = originalFrame }
        originalFrame = nil
      }
    }

    @objc private func moveGesture(_ gesture: UILongPressGestureRecognizer) {
      guard let coordinator, let owner = coordinator.owner, owner.configuration.isEditable else {
        return
      }
      switch gesture.state {
      case .began:
        originalFrame = frame
        moveStart = gesture.location(in: superview)
        alpha = 0.6
      case .changed:
        if let originalFrame, let moveStart {
          center.y = originalFrame.midY + gesture.location(in: superview).y - moveStart.y
        }
      case .ended:
        let point = gesture.location(in: owner.input)
        let input = owner.input
        let location = CGPoint(
          x: point.x - input.textContainerInset.left, y: point.y - input.textContainerInset.top)
        let character = input.layoutManager.characterIndex(
          for: location, in: input.textContainer, fractionOfDistanceBetweenInsertionPoints: nil)
        let line = owner.parser.lineIndex.line(containing: character)
        let start = owner.parser.lineIndex.start(ofLine: line)
        let fragment =
          start < input.textStorage.length
          ? input.layoutManager.lineFragmentRect(
            forGlyphAt: input.layoutManager.glyphIndexForCharacter(at: start), effectiveRange: nil)
          : input.layoutManager.extraLineFragmentRect
        coordinator.move(item, before: line + (location.y > fragment.midY ? 1 : 0))
        moveStart = nil
        originalFrame = nil
        alpha = 1
        coordinator.invalidate()
      default:
        if let originalFrame { frame = originalFrame }
        originalFrame = nil
        alpha = 1
      }
    }
  }

  extension UIView {
    var owningViewController: UIViewController? {
      var responder: UIResponder? = self
      while let current = responder {
        if let controller = current as? UIViewController { return controller }
        responder = current.next
      }
      return nil
    }
  }
#endif
