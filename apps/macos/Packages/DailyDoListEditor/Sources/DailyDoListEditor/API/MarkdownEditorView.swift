import AppKit
import SwiftUI

/// SwiftUI host for a controller.
public struct MarkdownEditorView: NSViewRepresentable {
  public let controller: MarkdownEditorController

  public init(controller: MarkdownEditorController) {
    self.controller = controller
  }

  public func makeNSView(context: Context) -> NSView { controller.view }
  public func updateNSView(_ nsView: NSView, context: Context) {}
}
