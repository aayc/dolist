import DailyDoListClient
import DailyDoListDomain
import DailyDoListDrawingModel
import DailyDoListMobileKit
import DailyDoListModels
import Foundation

extension PhoneWorkspace {
  var liveDocumentPaths: Set<String> { Set(sessions.keys).union(drawingSessions.keys) }
  var downloadBudget: Int {
    get {
      let stored = UserDefaults.standard.integer(forKey: "downloadBudget.\(profile.id)")
      return stored > 0 ? stored : 128
    }
    set { UserDefaults.standard.set(newValue, forKey: "downloadBudget.\(profile.id)") }
  }
  func storageMaintenance() throws -> WorkspaceStorageMaintenance {
    try WorkspaceStorageMaintenance(
      rootDirectory: rootDirectory, scope: repository.scope,
      budgetBytes: downloadBudget * 1_024 * 1_024)
  }

  func updateStorageInventory() async {
    do {
      storageInventory = try await storageMaintenance().inventory(protecting: liveDocumentPaths)
      contentInventory = try await contentCache.entries()
      contentUsage = try await contentCache.usage()
    } catch { self.error = error.localizedDescription }
  }

  func requestDownloads(_ selection: OfflineDownloadSelection) async {
    do {
      let storage = try storageMaintenance()
      try await storage.setPinned(selection, pinned: true)
      _ = try await storage.requestDownload(
        selection,
        paths: entries.filter { $0.kind == .file && $0.path.hasSuffix(".md") }.map(\.path))
      await updateStorageInventory()
      startDownloads()
    } catch { self.error = error.localizedDescription }
  }

  func downloadPinnedUpdates(_ tree: [VaultEntry]) async throws {
    try await storageMaintenance().requestPinnedUpdates(tree: tree)
    startDownloads()
  }

  func startDownloads() {
    guard online, let client else { return }
    if downloadTask != nil {
      downloadAgain = true
      return
    }
    let epoch = generation
    let identifier = UUID()
    downloadID = identifier
    downloadTask = Task { [weak self] in
      guard let self else { return }
      defer {
        if self.downloadID == identifier {
          self.downloadTask = nil
          self.downloadingPath = nil
          if self.downloadAgain, self.online {
            self.downloadAgain = false
            self.startDownloads()
          }
        }
      }
      do {
        let storage = try self.storageMaintenance()
        let inventory = try await storage.inventory(protecting: self.liveDocumentPaths)
        for request in inventory.downloads
        where request.state == .requested || request.state == .attempting {
          guard self.online, self.generation == epoch, !Task.isCancelled else { return }
          let ticket: DocumentDownloadTicket
          do { ticket = try await storage.beginDownload(request.path) } catch WorkspaceStorageError
            .staleDownload
          { continue }
          self.downloadingPath = request.path
          // Resuming an attempt issues a new request id; Cancel must see it before the read.
          await self.updateStorageInventory()
          do {
            let remote = try HTTPWorkspaceRemote(
              client: client, scope: self.repository.scope,
              noteDownloadLimit: ticket.maxBytes)
            let revision: Int64?
            if DrawingFileName.isDrawingPath(ticket.path) {
              let session = self.drawingSessions[ticket.path]
              await session?.checkpoint()
              guard session?.hasUncheckpointedEdits != true else {
                throw WorkspaceStorageError.unavailableCheckpoint
              }
              try await self.refreshDrawingChecked(ticket.path, remote: remote)
              revision = try await self.drawingRepository.drawing(ticket.path)?.localRevision
            } else {
              let session = self.sessions[ticket.path]
              await session?.checkpoint()
              guard session?.hasUncheckpointedEdits != true else {
                throw WorkspaceStorageError.unavailableCheckpoint
              }
              try await self.refreshChecked(ticket.path, remote: remote)
              revision = try await self.repository.note(ticket.path)?.localRevision
            }
            guard self.generation == epoch, !Task.isCancelled else { return }
            guard let revision else { throw WorkspaceStorageError.unavailableCheckpoint }
            try await storage.completeDownload(ticket, expectedRevision: revision)
          } catch WorkspaceStorageError.staleDownload {
            // A replaced or cancelled request cannot publish its old ticket.
          } catch {
            guard self.generation == epoch, !Task.isCancelled else { return }
            let tooLarge: Bool
            if case WorkspaceStorageError.downloadTooLarge = error {
              tooLarge = true
            } else {
              tooLarge = (error as? DaemonClientError)?.httpStatus == 413
            }
            do {
              try await storage.failDownload(
                ticket, failure: tooLarge ? .tooLarge : .downloadFailed)
            } catch WorkspaceStorageError.staleDownload {}
          }
          await self.updateStorageInventory()
        }
      } catch { if self.generation == epoch { self.error = error.localizedDescription } }
      await self.updateStorageInventory()
    }
  }

  func cancelDownload(_ request: DocumentDownloadRequest) async {
    do {
      try await storageMaintenance().cancelDownload(request.path, id: request.id)
      // Its immutable ticket rejects a late completion; the authenticated snapshot remains a
      // disposable cache read, never an upload or an action.
      await updateStorageInventory()
    } catch WorkspaceStorageError.staleDownload {
      await updateStorageInventory()
      error = "This download restarted before it could be cancelled. Cancel it again to stop it."
    } catch { self.error = error.localizedDescription }
  }

  func unpin(_ selection: OfflineDownloadSelection) async {
    do {
      try await storageMaintenance().setPinned(selection, pinned: false)
      await updateStorageInventory()
    } catch { self.error = error.localizedDescription }
  }

  func cleanDownloads() async {
    do {
      let storage = try storageMaintenance()
      let result = try await storage.trim(protecting: liveDocumentPaths)
      if result.unsupportedProtectedRecords > 0 {
        error =
          "This version cannot safely clean some newer protected records. Your files were kept."
      } else if result.busy {
        error = "A local save is in progress. Try cleanup again after it finishes."
      }
      _ = try await storage.collectGarbage()
      _ = try await contentCache.trim()
      await updateStorageInventory()
    } catch { self.error = error.localizedDescription }
  }
}
