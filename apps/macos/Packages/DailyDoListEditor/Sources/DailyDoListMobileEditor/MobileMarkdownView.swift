#if canImport(UIKit)
  import SwiftUI

  /// The controller persists across SwiftUI updates and owns the document and native undo state.
  public struct MobileMarkdownView: UIViewRepresentable {
    private let controller: MobileMarkdownController
    public init(controller: MobileMarkdownController) { self.controller = controller }
    public func makeUIView(context: Context) -> MarkdownInputView { controller.input }
    public func updateUIView(_ uiView: MarkdownInputView, context: Context) {}
  }
#endif
