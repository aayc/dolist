import AppKit
import SwiftUI

/// SwiftUI host for a controller.
public struct MarkdownEditorView: NSViewRepresentable {
  public let controller: MarkdownEditorController

  public init(controller: MarkdownEditorController) {
    self.controller = controller
  }

  public func makeNSView(context: Context) -> NSScrollView { controller.scrollView }
  public func updateNSView(_ nsView: NSScrollView, context: Context) {}
}
