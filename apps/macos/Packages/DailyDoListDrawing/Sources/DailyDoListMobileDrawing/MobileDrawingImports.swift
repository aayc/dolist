#if canImport(UIKit)
  import UIKit

  extension MobileDrawingController {
    public func insertImage(_ bytes: Data, replacing id: String? = nil, at point: DrawingPoint)
      throws
    {
      guard isEditing, !viewOnly else { throw MobileDrawingImportError.readOnly }
      let data: Data
      let mime: String
      if StaticSVGImage.decode(bytes) != nil {
        data = bytes
        mime = "image/svg+xml"
      } else {
        guard let image = EmbeddedDrawingImages.decode(bytes),
          let normalized = UIImage(cgImage: image).pngData()
        else { throw DrawingImageImportError.unreadable }
        data = normalized
        mime = "image/png"
      }
      try editor.validatedImport(validate: importContext().validate) { candidate in
        try candidate.insertImage(data: data, mimeType: mime, at: point, replacing: id)
      }
    }
    public func insertShapes(_ scene: ExcalidrawScene, at point: DrawingPoint) throws {
      guard isEditing, !viewOnly else { throw MobileDrawingImportError.readOnly }
      try editor.validatedImport(validate: importContext().validate) { candidate in
        try candidate.paste(scene, at: point)
      }
    }
  }
#endif
