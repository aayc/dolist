import DailyDoListMobileKit
import SwiftUI
import UniformTypeIdentifiers

struct PhoneAttachmentUploadsView: View {
  let online: Bool
  var copyDestination: String? = nil
  let load: @MainActor () async throws -> [AttachmentUpload]
  let checkAgain: @MainActor () async throws -> Void
  let cancel: @MainActor (AttachmentUpload) async throws -> Void
  let original: @MainActor (UUID) async throws -> Data
  let importCopy: @MainActor (AttachmentUpload, Data) async throws -> Void
  @State private var uploads: [AttachmentUpload] = []
  @State private var busy = false
  @State private var loaded = false
  @State private var failure: String?
  @State private var selection: AttachmentUpload?
  @State private var action: ReviewAction?
  @State private var exportDocument: AttachmentExportDocument?
  @State private var exportName = "Attachment"
  @State private var exportType: UTType = .data
  @State private var exporting = false
  @State private var exported = false

  private enum ReviewAction { case cancel, importCopy }

  var body: some View {
    List {
      if !loaded { ProgressView("Loading attachments…") }
      if !online {
        Label("Offline — originals stay on this iPhone", systemImage: "wifi.slash")
          .foregroundStyle(.secondary)
      }
      Section("Pending uploads") {
        let pending = uploads.filter { $0.state.unresolved }
        if loaded && failure == nil && pending.isEmpty {
          Text("No pending attachment uploads").foregroundStyle(.secondary)
        }
        ForEach(pending) { row($0) }
      }
      let completed = uploads.filter { !$0.state.unresolved }
      if !completed.isEmpty {
        Section("History") {
          ForEach(completed) { row($0) }
        }
      }
      if busy { ProgressView("Working…") }
      if exported { Label("Original exported to Files", systemImage: "checkmark.circle") }
      if let failure { Text(failure).foregroundStyle(.red).textSelection(.enabled) }
    }
    .navigationTitle("Attachments")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button("Check uploads", systemImage: "arrow.clockwise") { perform(checkAgain) }
          .disabled(!online || busy).accessibilityIdentifier("attachments.check")
      }
    }
    .task { await refresh() }
    .refreshable { await refresh() }
    .confirmationDialog(
      action == .cancel ? "Cancel this upload?" : "Import a separate copy?",
      isPresented: Binding(get: { action != nil }, set: { if !$0 { action = nil } }),
      titleVisibility: .visible
    ) {
      if let selected = selection {
        if action == .cancel {
          Button("Cancel upload", role: .destructive) { perform { try await cancel(selected) } }
        } else {
          Button("Import as a new attachment") {
            perform { try await importCopy(selected, original(selected.id)) }
          }
        }
      }
      Button("Keep original", role: .cancel) {}
    } message: {
      if action == .cancel {
        Text(
          "Remove or replace its embed in the note before that note can sync. The cancelled original may be removed from this iPhone's cache."
        )
      } else {
        if let copyDestination {
          Text("Matching references in \(copyDestination) will use the new attachment.")
        }
        Text(
          "This creates another attachment at a new path. The original upload remains in recovery history; no existing host file is overwritten."
        )
      }
    }
    .fileExporter(
      isPresented: $exporting, document: exportDocument, contentType: exportType,
      defaultFilename: exportName
    ) { result in
      switch result {
      case .success: exported = true
      case .failure(let error): failure = error.localizedDescription
      }
      exportDocument = nil
    }
  }

  @ViewBuilder private func row(_ upload: AttachmentUpload) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(upload.originalFilename).font(.headline)
      Text(upload.path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
      Text(ByteCountFormatter.string(fromByteCount: Int64(upload.byteCount), countStyle: .file))
        .font(.caption).foregroundStyle(.secondary)
      Text(status(upload)).font(.footnote)
      HStack {
        Button("Export original", systemImage: "square.and.arrow.up") { export(upload) }
          .accessibilityIdentifier("attachments.export.\(upload.id.uuidString)")
        if upload.state.unresolved && upload.attemptCount == 0 {
          Button("Cancel upload", role: .destructive) {
            selection = upload
            action = .cancel
          }
        }
      }.buttonStyle(.borderless)
      if upload.state == .needsReview {
        Button("Import as a new attachment") {
          selection = upload
          action = .importCopy
        }
        .disabled(copyDestination == nil)
        .accessibilityIdentifier("attachments.copy.\(upload.id.uuidString)")
        .buttonStyle(.borderless)
      }
    }
    .padding(.vertical, 4)
    .disabled(busy)
  }

  private func status(_ upload: AttachmentUpload) -> String {
    switch upload.state {
    case .queued:
      online
        ? "Saved on this iPhone. Ready to upload."
        : "Saved on this iPhone. Waiting for a connection."
    case .attempting:
      "The host may have received this file. Check uploads to confirm before its note can sync."
    case .acknowledged: "Uploaded."
    case .cancelled: "Upload cancelled."
    case .needsReview:
      switch upload.reviewReason {
      case .pathCollision: "Another file already occupies this path. Your original has been kept."
      case .uncertainMissing:
        "The host file is missing. It may have been deleted after upload, so it will not be recreated automatically."
      case .remoteChanged:
        "The host file differs from this original. Neither file will be overwritten."
      case .invalidReceipt:
        "The host reply could not confirm this upload. Check again or export the original for review."
      case nil: "This upload needs review. Its original is retained on this iPhone."
      }
    }
  }

  private func export(_ upload: AttachmentUpload) {
    exported = false
    perform {
      exportDocument = try await AttachmentExportDocument(data: original(upload.id))
      exportName = upload.originalFilename
      exportType =
        UTType(filenameExtension: (upload.originalFilename as NSString).pathExtension) ?? .data
      exporting = true
    }
  }

  private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
    guard !busy else { return }
    busy = true
    failure = nil
    Task {
      defer { busy = false }
      do {
        try await operation()
        await refresh()
      } catch { failure = error.localizedDescription }
    }
  }

  private func refresh() async {
    defer { loaded = true }
    do {
      uploads = try await load()
      failure = nil
    } catch { failure = error.localizedDescription }
  }
}
