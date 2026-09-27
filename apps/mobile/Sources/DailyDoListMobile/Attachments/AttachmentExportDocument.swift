import DailyDoListModels
import SwiftUI
import UniformTypeIdentifiers

struct AttachmentExportDocument: FileDocument {
  static var readableContentTypes: [UTType] { [.data] }
  let data: Data

  init(data: Data) throws {
    guard data.count <= DaemonProtocol.attachmentMaxBytes else {
      throw AttachmentImportError.tooLarge
    }
    self.data = data
  }
  init(configuration: ReadConfiguration) throws {
    guard let data = configuration.file.regularFileContents else {
      throw AttachmentImportError.notAFile
    }
    try self.init(data: data)
  }
  func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
    FileWrapper(regularFileWithContents: data)
  }
}
