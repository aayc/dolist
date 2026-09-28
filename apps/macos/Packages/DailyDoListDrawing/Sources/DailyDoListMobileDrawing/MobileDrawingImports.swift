#if canImport(UIKit)
  import UIKit

  /// Imports commit through the document owner's request-size preflight as one undo step. Edit
  /// authority is checked when an import applies, which for a photo is after an arbitrary wait.
  extension MobileDrawingController {
    public func insertImage(_ bytes: Data, replacing id: String? = nil, at point: DrawingPoint)
      throws
    {
      try requireEditable()
      if let id {
        guard let target = editor.element(id), target.type == .image, !target.isDeleted,
          !target.locked
        else { throw MobileDrawingImportError.targetUnavailable }
      }
      let data: Data
      let mime: String
      if StaticSVGImage.decode(bytes) != nil {
        data = bytes
        mime = "image/svg+xml"
      } else {
        // Normalize raster orientation and format once; accepted SVG bytes stay verbatim.
        guard let image = EmbeddedDrawingImages.decode(bytes),
          let normalized = UIImage(cgImage: image).pngData()
        else { throw DrawingImageImportError.unreadable }
        data = normalized
        mime = "image/png"
      }
      try importChecked { candidate in
        try candidate.insertImage(data: data, mimeType: mime, at: point, replacing: id)
      }
    }
    public func insertShapes(_ scene: ExcalidrawScene, at point: DrawingPoint) throws {
      try requireEditable()
      try importChecked { candidate in try candidate.paste(scene, at: point) }
    }

    func requireEditable() throws {
      guard isEditing, !viewOnly else { throw MobileDrawingImportError.readOnly }
    }
    @discardableResult
    func importChecked<Result>(_ operation: (DrawingEditor) throws -> Result) throws -> Result {
      try editor.validatedImport(validate: importContext().validate, operation: operation)
    }
  }
#endif
