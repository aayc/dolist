import DailyDoListMobileEditor
import DailyDoListMobileKit
import DailyDoListModels
import Foundation
import UniformTypeIdentifiers

extension PhoneWorkspace {
  func importAttachment(_ data: Data, filename: String, into session: NoteSession) async throws {
    guard sessions[session.note.path] === session, !structuralBusy,
      session.editor.configuration.isEditable, session.editor.input.markedTextRange == nil
    else { throw WorkspaceRepositoryError.connectionChanged }
    let upload = try await attachmentUploads.prepare(data: data, originalFilename: filename)
    // Bytes are durable even if a navigation/retirement raced the file picker. Never insert
    // into a replacement editor; the retained original remains available in upload review.
    guard sessions[session.note.path] === session, !structuralBusy,
      session.editor.insertAttachment(target: upload.path)
    else { throw WorkspaceRepositoryError.connectionChanged }
    includeAttachments([upload])
    session.editor.attachmentsDidChange()
    await session.checkpoint()
    if let error = session.error { throw PhoneAttachmentError.checkpoint(error) }
    Task { await synchronize() }
  }

  func replaceAttachment(_ original: AttachmentUpload, data: Data) async throws {
    guard let session = active, !structuralBusy,
      MobileMarkdownController.attachmentTargets(in: session.editor.text).contains(original.path),
      session.editor.configuration.isEditable, session.editor.input.markedTextRange == nil
    else {
      throw PhoneAttachmentError.checkpoint(
        "Open the editable note containing this attachment before importing a replacement.")
    }
    let upload = try await attachmentUploads.prepare(
      data: data, originalFilename: original.originalFilename)
    guard active === session, sessions[session.note.path] === session,
      session.editor.replaceAttachment(target: original.path, with: upload.path)
    else { throw WorkspaceRepositoryError.connectionChanged }
    includeAttachments([upload])
    session.editor.attachmentsDidChange()
    await session.checkpoint()
    if let error = session.error { throw PhoneAttachmentError.checkpoint(error) }
    Task { await synchronize() }
  }

  func syncAttachments(epoch: UInt64) async throws {
    guard let client, online, generation == epoch else { return }
    guard try await attachmentUploads.uploads().contains(where: { $0.state.unresolved }) else {
      return
    }
    let uploads = try await attachmentUploads.synchronize(
      with: HTTPAttachmentUploadRemote(client: client, scope: repository.scope))
    guard generation == epoch else { return }
    includeAttachments(uploads)
    for upload in uploads where upload.state == .acknowledged {
      guard let receipt = upload.receipt, try await contentCache.attachment(upload.path) == nil
      else { continue }
      // Acknowledged originals may already have been reclaimed; that is a cache miss, not a
      // reason to recreate the remote attachment or block unrelated notes.
      if let bytes = try? await attachmentUploads.bytes(upload.id) {
        let ticket = try await contentCache.beginAttachmentFetch(upload.path)
        _ = try await contentCache.storeAttachment(
          VaultFilePayload(data: bytes, metadata: receipt), fetch: ticket)
      }
    }
    for session in sessions.values { session.editor.attachmentsDidChange() }
  }

  func includeAttachments(_ uploads: [AttachmentUpload]) {
    let known = Set(entries.map(\.path))
    entries += uploads.filter { $0.state != .cancelled && !known.contains($0.path) }.map {
      VaultEntry(path: $0.path, kind: .file, version: $0.receipt?.version)
    }
    entries.sort { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
  }

  func pendingAttachment(_ path: String) async throws -> MobileEditorAttachment? {
    guard
      let upload = try await attachmentUploads.uploads().first(where: {
        $0.path == path && $0.state.unresolved
      })
    else { return nil }
    let bytes = try await attachmentUploads.bytes(upload.id)
    let mime =
      UTType(filenameExtension: (path as NSString).pathExtension)?.preferredMIMEType
      ?? "application/octet-stream"
    return MobileEditorAttachment(path: path, data: bytes, mimeType: mime, version: upload.sha256)
  }
}

private enum PhoneAttachmentError: Error, LocalizedError {
  case checkpoint(String)
  var errorDescription: String? {
    switch self {
    case .checkpoint(let message): message
    }
  }
}
