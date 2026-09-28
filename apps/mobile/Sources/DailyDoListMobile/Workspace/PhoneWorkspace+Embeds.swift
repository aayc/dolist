import DailyDoListClient
import DailyDoListDomain
import DailyDoListDrawingModel
import DailyDoListEditorCore
import DailyDoListMobileEditor
import DailyDoListMobileKit
import DailyDoListModels
import Foundation
import UIKit

extension PhoneWorkspace {
  func configureEmbedHosts() {
    for session in sessions.values { configureEmbeds(session) }
  }

  func configureEmbeds(_ session: NoteSession) {
    let path = session.note.path
    let epoch = generation
    var host = MobileEditorEmbedHost()
    host.loadDrawing = { [weak self] target in
      guard let self, self.generation == epoch else { return .unreadable }
      return await self.embeddedDrawing(target, from: path, epoch: epoch)
    }
    host.loadAttachment = { [weak self] target in
      guard let self, self.generation == epoch else { return .unavailable }
      return await self.embeddedAttachment(target, from: path, epoch: epoch)
    }
    host.drawingController = { [weak self] in self?.drawingSessions[$0]?.controller }
    host.onOpenDrawing = { [weak self] target in Task { await self?.openDrawing(target) } }
    host.onOpenLink = { [weak self] target in self?.openEditorLink(target, from: path) }
    host.onPreviewLink = { [weak self] request in
      guard let self, self.generation == epoch else { return }
      self.routedLink = PhoneLinkDestination(
        request: PhoneNoteLinkRequest(link: request),
        sourcePath: path, generation: epoch)
    }
    session.requiredAttachments = { [weak self] text in
      guard let self else { throw WorkspaceRepositoryError.connectionChanged }
      let targets = Set(
        MobileMarkdownController.attachmentTargets(in: text).compactMap {
          self.embedPath($0, from: path)
        })
      return try await self.attachmentUploads.uploads().filter {
        targets.contains($0.path)
      }.map(\.dependency)
    }
    session.requiredDrawings = { [weak self] text in
      guard let self else { return [] }
      let paths = Set(
        text.components(separatedBy: "\n").compactMap {
          DrawingEmbed.parse(line: $0).flatMap { self.embedPath($0.target, from: path) }
        })
      var dependencies: [String] = []
      for path in paths {
        if let drawing = try? await self.drawingRepository.drawing(path),
          drawing.state != .synced || self.drawingSessions[path]?.hasUncheckpointedEdits == true
        {
          dependencies.append(path)
        }
      }
      return dependencies.sorted()
    }
    session.editor.setEmbedHost(host, identity: "\(profile.id):\(epoch):\(path)")
  }

  /// Resolve against the downloaded tree, preferring an explicit path relative to this note.
  /// Never convert an external URL or escaping path into a local request.
  func embedPath(_ requested: String, from note: String) -> String? {
    let target = requested.components(separatedBy: "#")[0]
    guard URLComponents(string: target)?.scheme == nil, !target.hasPrefix("//") else { return nil }
    let paths = entries.filter { $0.kind == .file }.map(\.path)
    let folder = note.split(separator: "/").dropLast().joined(separator: "/")
    let relative = folder.isEmpty ? target : folder + "/" + target
    if let path = try? VaultPath.validated(relative), paths.contains(path) { return path }
    guard let resolved = WikiLinks.resolve(target, in: paths),
      (try? VaultPath.validated(resolved)) == resolved
    else { return nil }
    return resolved
  }

  private func embeddedDrawing(_ target: String, from note: String, epoch: UInt64) async
    -> EditorDrawingState
  {
    guard let path = embedPath(target, from: note), DrawingEmbed.isDrawingTarget(path) else {
      return .missing
    }
    if let remote, online { await refreshDrawing(path, remote: remote) }
    guard generation == epoch, !Task.isCancelled else { return .unreadable }
    do {
      guard let drawing = try await drawingRepository.drawing(path), generation == epoch else {
        return .unreadable
      }
      guard drawing.document.readable else { return .unreadable }
      let session = drawingSession(drawing)
      return .ready(
        EditorDrawing(
          path: path, scene: session.controller.scene,
          contentHash: DrawingContentHash.hash(session.controller.scene)))
    } catch { return .unreadable }
  }

  private func embeddedAttachment(_ target: String, from note: String, epoch: UInt64) async
    -> MobileEditorAttachmentState
  {
    guard let path = embedPath(target, from: note) else { return .missing }
    do {
      if let pending = try await pendingAttachment(path), epoch == generation {
        return .ready(pending)
      }
      if let client, online {
        let ticket = try await contentCache.beginAttachmentFetch(path)
        do {
          let payload = try await client.readFile(path)
          guard epoch == generation, !Task.isCancelled else { return .unavailable }
          _ = try await contentCache.storeAttachment(payload, fetch: ticket)
          return .ready(editorAttachment(payload))
        } catch DaemonClientError.http(let status, _) where status == 404 {
          guard epoch == generation else { return .unavailable }
          try await contentCache.remove(.attachment(path: path))
          return .missing
        } catch {
          guard epoch == generation, !Task.isCancelled else { return .unavailable }
          // An outage can use an earlier authenticated snapshot from this exact workspace.
        }
      }
      guard let payload = try await contentCache.attachment(path), epoch == generation else {
        return .unavailable
      }
      return .ready(editorAttachment(payload))
    } catch { return .unavailable }
  }

  private func editorAttachment(_ payload: VaultFilePayload) -> MobileEditorAttachment {
    MobileEditorAttachment(
      path: payload.metadata.path, data: payload.data,
      mimeType: payload.metadata.mimeType, version: payload.metadata.version)
  }

  func insertDrawing(named name: String, into session: NoteSession) async {
    do {
      let path = DrawingFileName.path(forName: name, folder: "Excalidraw")
      let drawing = try await drawingRepository.create(path: path)
      includeLocalDrawings([drawing])
      _ = drawingSession(drawing)
      _ = session.editor.insertDrawing(target: path)
      await session.checkpoint()
      await synchronize()
    } catch { self.error = error.localizedDescription }
  }

  func openEditorLink(_ target: EditorLinkPreview.Target, from note: String) {
    Task { await followEditorLink(target, from: note) }
  }

  func followEditorLink(_ target: EditorLinkPreview.Target, from note: String) async {
    switch target {
    case .external(let url):
      if LinkPolicy.isAllowed(url) { await UIApplication.shared.open(url) }
    case .note(let target, let subpath):
      let path = target.isEmpty ? note : embedPath(target, from: note)
      guard let path else {
        error = "This linked note is not in the downloaded file list."
        return
      }
      let epoch = generation
      let request = navigation &+ 1
      await open(path)
      guard epoch == generation, navigation == request, let subpath else { return }
      if let drawing = activeDrawing, drawing.drawing.path == path {
        guard subpath.hasPrefix("^"), drawing.controller.focusElement(String(subpath.dropFirst()))
        else {
          error = "This drawing element is no longer available."
          return
        }
        return
      }
      guard active?.note.path == path else { return }
      let lines = active?.editor.text.components(separatedBy: "\n") ?? []
      let line = lines.firstIndex { value in
        if subpath.hasPrefix("^") { return value.hasSuffix(subpath) }
        return value.trimmingCharacters(in: CharacterSet(charactersIn: "# "))
          .localizedCaseInsensitiveCompare(subpath) == .orderedSame
      }
      if let line { revealLine(line) }
    }
  }
}
