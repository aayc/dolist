#if canImport(UIKit)
  import SwiftUI
  import UIKit

  extension MobileDrawingController {
    public var insertionPoint: DrawingPoint {
      guard let canvas else { return .zero }
      return canvas.viewport.viewToScene(CGPoint(x: canvas.bounds.midX, y: canvas.bounds.midY))
    }
    public func copySelection(cut: Bool = false) throws {
      guard let scene = editor.copiedScene() else { return }
      let text = DrawingClipboard.encode(scene)
      guard text.utf8.count <= DrawingClipboard.maximumBytes else {
        throw DrawingTransferError.tooLarge
      }
      UIPasteboard.general.items = [
        [DrawingClipboard.contentType: Data(text.utf8), "public.utf8-plain-text": text]
      ]
      if cut { editor.deleteSelection() }
    }
    public func pasteSelection() throws {
      let pasteboard = UIPasteboard.general
      if let data = pasteboard.data(forPasteboardType: DrawingClipboard.contentType),
        let text = String(data: data, encoding: .utf8)
      {
        _ = try editor.paste(DrawingClipboard.decode(text), at: insertionPoint)
      } else if let text = pasteboard.string {
        _ = try editor.paste(DrawingClipboard.decode(text), at: insertionPoint)
      } else if let image = pasteboard.image, let data = image.pngData() {
        _ = try editor.insertImage(data: data, mimeType: "image/png", at: insertionPoint)
      } else {
        throw DrawingTransferError.invalid
      }
    }
    public func copyStyle() {
      guard let first = editor.selectedElements.first else { return }
      UIPasteboard.general.setData(
        Data(JSONWriter.string(.object(ElementCodec.encode(first))).utf8),
        forPasteboardType: "app.dailydolist.drawing-style")
    }
    public func pasteStyle() throws {
      guard
        let data = UIPasteboard.general.data(forPasteboardType: "app.dailydolist.drawing-style"),
        data.count <= DrawingClipboard.maximumBytes, let text = String(data: data, encoding: .utf8),
        let object = try JSONParser.parse(text).objectValue, let value = ElementCodec.decode(object)
      else { throw DrawingTransferError.invalid }
      editor.pasteStyle(from: value)
    }
    public func copySelectionSVG() throws {
      guard let scene = editor.copiedScene() else { return }
      let svg = try DrawingSVG.render(scene, theme: canvas?.theme ?? .light)
      UIPasteboard.general.items = [
        ["public.svg-image": Data(svg.utf8), "public.utf8-plain-text": svg]
      ]
    }
    public func copySelectionImage() throws {
      guard let scene = editor.copiedScene(),
        let image = DrawingImage.render(
          scene, scale: 2, theme: canvas?.theme ?? .light, background: .transparent)
      else { throw DrawingTransferError.invalid }
      UIPasteboard.general.image = UIImage(cgImage: image)
    }
  }

  struct MobileDrawingTransfer: View {
    let controller: MobileDrawingController
    @State private var link = ""
    @State private var error: String?
    private var single: ExcalidrawElement? {
      controller.editor.selectedElements.count == 1 ? controller.editor.selectedElements.first : nil
    }
    var body: some View {
      Form {
        Section("Clipboard") {
          Button("Copy selection") { perform { try controller.copySelection() } }
            .disabled(controller.editor.selectedIds.isEmpty)
          Button("Cut selection") { perform { try controller.copySelection(cut: true) } }
            .disabled(controller.editor.selectedIds.isEmpty)
          Button("Paste") { perform { try controller.pasteSelection() } }
          Button("Copy style") { controller.copyStyle() }.disabled(single == nil)
          Button("Paste style") { perform { try controller.pasteStyle() } }
            .disabled(controller.editor.selectedIds.isEmpty)
          Button("Copy as PNG") { perform { try controller.copySelectionImage() } }
            .disabled(controller.editor.selectedIds.isEmpty)
        }
        Section {
          Button("Copy as SVG") { perform { try controller.copySelectionSVG() } }
            .disabled(controller.editor.selectedIds.isEmpty)
        }
        Section {
          NavigationLink("Shape library") { MobileDrawingLibraryView(controller: controller) }
        }
        Section("Element link") {
          if let single {
            TextField("URL or note link", text: $link).textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .onAppear { link = single.link ?? "" }
            Button("Save link") { controller.editor.setSelectionLink(link) }
            Button("Remove link") {
              controller.editor.setSelectionLink(nil)
              link = ""
            }.disabled(single.link == nil)
            Button("Open link") { if let link = single.link { controller.onOpenLink?(link) } }
              .disabled(single.link == nil || controller.onOpenLink == nil)
            Button("Copy link to this element") {
              if let value = controller.elementLink?(single.id) {
                UIPasteboard.general.string = value
              }
            }.disabled(controller.elementLink == nil)
          } else {
            Text("Select one element to edit or open its link.")
          }
        }
        if let error { Section { Text(error).foregroundStyle(.red) } }
      }.navigationTitle("Copy, library and links")
    }
    private func perform(_ operation: () throws -> Void) {
      do {
        try operation()
        error = nil
      } catch { self.error = error.localizedDescription }
    }
  }
#endif
