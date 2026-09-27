import CoreGraphics
import Foundation

public enum DrawingImageImportError: Error, LocalizedError {
  case unreadable
  public var errorDescription: String? {
    "This image could not be read. Choose a supported image smaller than 32 MB."
  }
}

extension DrawingEditor {
  /// Inserts embedded bytes or replaces one selected image. Old files remain available to
  /// tombstones and undo; IDs and unknown metadata of every existing file stay untouched.
  @discardableResult
  public func insertImage(
    data: Data, mimeType: String, at point: DrawingPoint, replacing id: String? = nil
  ) throws -> String {
    guard let image = EmbeddedDrawingImages.decode(data), mimeType.hasPrefix("image/"),
      !mimeType.contains(","), !mimeType.contains(";")
    else { throw DrawingImageImportError.unreadable }
    guard scene.files.objectValue != nil else { throw DrawingImageImportError.unreadable }
    if let id {
      guard let current = element(id), current.type == .image, !current.isDeleted, !current.locked
      else {
        throw DrawingImageImportError.unreadable
      }
    }
    finishInteraction()
    let fileId = environment.randomId()
    var files = scene.files.objectValue ?? JSONObject()
    files[fileId] = .object(
      JSONObject([
        ("id", .string(fileId)), ("mimeType", .string(mimeType)),
        ("dataURL", .string("data:\(mimeType);base64,\(data.base64EncodedString())")),
        ("created", .number(Double(environment.now()))),
      ]))
    scene.files = .object(files)
    let elementId: String
    if let id, let current = element(id), current.type == .image, !current.isDeleted,
      !current.locked
    {
      update(id) { element in
        element.setExtraField("fileId", .string(fileId))
        element.setExtraField("status", .string("saved"))
        element.setExtraField("crop", .null)
      }
      elementId = id
    } else {
      var element = newElement(.image, at: point)
      let fit = min(1, 480 / Double(max(image.width, image.height)))
      element.width = Double(image.width) * fit
      element.height = Double(image.height) * fit
      element.setExtraField("fileId", .string(fileId))
      element.setExtraField("status", .string("saved"))
      element.setExtraField("scale", .array([.number(1), .number(1)]))
      element.setExtraField("crop", .null)
      insert(element)
      elementId = element.id
    }
    tool = .selection
    select([elementId])
    commit()
    return elementId
  }

  /// Crop coordinates are fractions of the original image, so the UI can use any preview size.
  public func cropImage(_ id: String, rect: DrawingRect?) {
    guard let element = element(id), element.type == .image, !element.locked,
      let fileId = element.fileId,
      let dataURL = scene.files.objectValue?[fileId]?.objectValue?["dataURL"]?.stringValue,
      let data = EmbeddedDrawingImages.data(from: dataURL),
      let image = EmbeddedDrawingImages.decode(data)
    else { return }
    finishInteraction()
    if let rect {
      guard [rect.minX, rect.minY, rect.maxX, rect.maxY].allSatisfy({ $0.isFinite }),
        rect.minX >= 0, rect.minY >= 0, rect.maxX <= 1, rect.maxY <= 1,
        rect.width > 0, rect.height > 0
      else { return }
      update(id) { value in
        value.setExtraField(
          "crop",
          .object(
            JSONObject([
              ("x", .number(rect.minX * Double(image.width))),
              ("y", .number(rect.minY * Double(image.height))),
              ("width", .number(rect.width * Double(image.width))),
              ("height", .number(rect.height * Double(image.height))),
              ("naturalWidth", .number(Double(image.width))),
              ("naturalHeight", .number(Double(image.height))),
            ])))
        value.height =
          value.width * rect.height * Double(image.height) / (rect.width * Double(image.width))
      }
    } else {
      update(id) {
        $0.setExtraField("crop", .null)
        $0.height = $0.width * Double(image.height) / Double(image.width)
      }
    }
    commit()
  }
}
