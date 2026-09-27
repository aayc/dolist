#if canImport(UIKit)
  import PhotosUI
  import SwiftUI
  import UniformTypeIdentifiers

  /// Explicit user-selected files/photos only. Upload acknowledgement precedes source insertion.
  public struct MobileEditorAttachmentImportButton: View {
    public let controller: MobileMarkdownController
    @State private var files = false
    @State private var photos = false
    @State private var photo: PhotosPickerItem?
    @State private var busy = false
    @State private var error: String?
    @State private var importIdentity: String?
    @State private var importGeneration: Int?
    public init(controller: MobileMarkdownController) { self.controller = controller }
    public var body: some View {
      Menu {
        Button("Choose file") {
          captureOwner()
          files = true
        }
        Button("Choose photo") {
          captureOwner()
          photos = true
        }
      } label: {
        Image(systemName: "paperclip").frame(minWidth: 44, minHeight: 44)
      }
      .accessibilityLabel("Insert attachment")
      .disabled(busy || !controller.configuration.isEditable)
      .fileImporter(isPresented: $files, allowedContentTypes: [.image, .pdf]) { result in
        Task { @MainActor in
          do {
            let url = try result.get()
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
            guard size <= MobileAttachmentDecoder.maximumBytes else { throw ImportError.tooLarge }
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            await upload(
              data, name: url.lastPathComponent,
              type: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                ?? "application/octet-stream")
          } catch { self.error = error.localizedDescription }
        }
      }
      .photosPicker(isPresented: $photos, selection: $photo, matching: .images)
      .onChange(of: photo) { _, item in
        guard let item else { return }
        Task { @MainActor in
          do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
              throw ImportError.unreadable
            }
            let type = item.supportedContentTypes.first ?? .image
            await upload(
              data, name: "Photo.\(type.preferredFilenameExtension ?? "jpg")",
              type: type.preferredMIMEType ?? "image/jpeg")
          } catch { self.error = error.localizedDescription }
          photo = nil
        }
      }
      .alert(
        "Attachment import",
        isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })
      ) {
        Button("OK") { error = nil }
      } message: {
        Text(error ?? "")
      }
    }
    @MainActor private func upload(_ data: Data, name: String, type: String) async {
      guard importIdentity == controller.embeds.identity,
        importGeneration == controller.embeds.generation
      else {
        error = "The active note or host changed. Choose the attachment again."
        return
      }
      busy = true
      defer { busy = false }
      do {
        guard data.count <= MobileAttachmentDecoder.maximumBytes else { throw ImportError.tooLarge }
        let inserted = try await controller.importAttachment(
          data: data, filename: name, mimeType: type)
        if !inserted {
          error = "The attachment was not inserted. Check the connection and active note."
        }
      } catch { self.error = error.localizedDescription }
    }
    @MainActor private func captureOwner() {
      importIdentity = controller.embeds.identity
      importGeneration = controller.embeds.generation
    }
    private enum ImportError: LocalizedError {
      case tooLarge, unreadable
      var errorDescription: String? {
        self == .tooLarge ? "Attachments must be 32 MB or smaller." : "This file could not be read."
      }
    }
  }
#endif
