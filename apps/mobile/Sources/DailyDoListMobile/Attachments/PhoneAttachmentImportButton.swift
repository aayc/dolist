import CoreTransferable
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The callback must persist bytes and checkpoint the containing note before reporting success.
/// Root composition captures the intended editor and verifies its connection/session identity.
struct PhoneAttachmentImportButton: View {
  let importAttachment: @MainActor (Data, String) async throws -> Void
  @State private var showFiles = false
  @State private var showPhotos = false
  @State private var photo: PhotosPickerItem?
  @State private var busy = false
  @State private var failure: String?
  @State private var task: Task<Void, Never>?

  var body: some View {
    Menu {
      Button("Choose from Files", systemImage: "folder") { showFiles = true }
      Button("Choose from Photos", systemImage: "photo") { showPhotos = true }
      Text("Original files up to 5 MB")
    } label: {
      if busy {
        ProgressView().accessibilityLabel("Importing attachment")
      } else {
        Label("Attach file or photo", systemImage: "paperclip")
      }
    }
    .disabled(busy)
    .accessibilityIdentifier("attachments.import")
    .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image, .pdf]) { result in
      switch result {
      case .success(let url): begin { try await AttachmentOriginalLoader.load(url) }
      case .failure(let error): failure = error.localizedDescription
      }
    }
    .photosPicker(
      isPresented: $showPhotos, selection: $photo,
      matching: .images, preferredItemEncoding: .current
    )
    .onChange(of: photo) { _, selected in
      guard let selected else { return }
      photo = nil
      begin {
        guard let value = try await selected.loadTransferable(type: PhotoOriginal.self) else {
          throw AttachmentImportError.unavailable
        }
        if (try? AttachmentOriginalLoader.validateEmbedFilename(value.file.filename)) != nil {
          return value.file
        }
        let suppliedExtension = (value.file.filename as NSString).pathExtension.lowercased()
        guard suppliedExtension.isEmpty || suppliedExtension == "tmp" else {
          throw AttachmentImportError.unsupportedFormat
        }
        // Some picker providers hand out an extensionless temporary name. Use the advertised
        // image representation's extension without decoding or changing the selected bytes.
        for type in selected.supportedContentTypes {
          if let suffix = type.preferredFilenameExtension,
            (try? AttachmentOriginalLoader.validateEmbedFilename("Photo." + suffix)) != nil
          {
            return ImportedAttachment(data: value.file.data, filename: "Photo." + suffix)
          }
        }
        throw AttachmentImportError.unsupportedFormat
      }
    }
    .alert(
      "Attachment import needs attention",
      isPresented: Binding(
        get: { failure != nil }, set: { if !$0 { failure = nil } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(failure ?? "")
    }
    .onDisappear { task?.cancel() }
  }

  private func begin(_ load: @escaping @MainActor () async throws -> ImportedAttachment) {
    guard !busy else { return }
    busy = true
    failure = nil
    task = Task {
      defer {
        busy = false
        task = nil
      }
      do {
        let file = try await load()
        try Task.checkCancellation()
        try AttachmentOriginalLoader.validateEmbedFilename(file.filename)
        try await importAttachment(file.data, file.filename)
      } catch is CancellationError {} catch { failure = error.localizedDescription }
    }
  }
}

/// Request the picker-provided current file representation. Do not decode through UIImage or
/// re-encode to JPEG: that would lose original bytes, animation, metadata or the selected image format.
private struct PhotoOriginal: Transferable {
  let file: ImportedAttachment
  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .image) { received in
      PhotoOriginal(file: try await AttachmentOriginalLoader.load(received.file))
    }
  }
}
