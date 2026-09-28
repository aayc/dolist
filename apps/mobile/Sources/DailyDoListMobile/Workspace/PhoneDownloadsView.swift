import DailyDoListMobileKit
import SwiftUI

struct PhoneDownloadsView: View {
  @Bindable var workspace: PhoneWorkspace
  @State private var budget = 128
  var body: some View {
    List {
      Section("Offline notes and drawings") {
        Text(
          "Recent notes are kept on this iPhone. Pin a note, folder, or the whole vault to keep it during cleanup. Downloads resume when this connection is available."
        )
        .font(.footnote).foregroundStyle(.secondary)
        Button("Download all notes and drawings", systemImage: "arrow.down.circle") {
          Task { await workspace.requestDownloads(.allDocuments) }
        }
        if let path = workspace.activePath {
          Button("Keep current note offline", systemImage: "pin") {
            Task { await workspace.requestDownloads(.document(path)) }
          }
        }
        Menu("Download a folder", systemImage: "folder.badge.plus") {
          ForEach(workspace.entries.filter { $0.kind == .folder }, id: \.path) { entry in
            Button(entry.path) { Task { await workspace.requestDownloads(.folder(entry.path)) } }
          }
        }
        if !workspace.online {
          Text("Offline · download requests are saved until you reconnect.").font(.footnote)
        }
        if let path = workspace.downloadingPath { Label(path, systemImage: "arrow.down") }
      }
      if let inventory = workspace.storageInventory {
        Section("Storage") {
          LabeledContent("Downloaded", value: bytes(inventory.usage.checkpointBytes))
          LabeledContent("Protected work and pins", value: bytes(inventory.usage.protectedBytes))
          Picker("Cache budget", selection: $budget) {
            ForEach([32, 64, 128, 256, 512], id: \.self) { Text("\($0) MB").tag($0) }
          }
          Text(
            "The budget applies to clean, unpinned markdown. Unsent work, recovery copies and open editors are preserved even above the budget. Attachments and conversations use a separate 64 MB cache."
          )
          .font(.footnote).foregroundStyle(.secondary)
          Button("Clean unused downloads", systemImage: "archivebox") {
            Task { await workspace.cleanDownloads() }
          }
        }
        if !inventory.selections.isEmpty {
          Section("Kept offline") {
            ForEach(inventory.selections, id: \.self) { selection in
              HStack {
                Label(label(selection), systemImage: "pin.fill")
                Spacer()
                Button("Unpin") { Task { await workspace.unpin(selection) } }.buttonStyle(
                  .borderless)
              }
            }
          }
        }
        let pending = inventory.downloads.filter {
          $0.state != .available && $0.state != .cancelled
        }
        if !pending.isEmpty {
          Section("Downloads") {
            ForEach(pending) { request in
              VStack(alignment: .leading, spacing: 5) {
                Text(request.path)
                Text(
                  request.state == .failed
                    ? failure(request.failure)
                    : request.state == .attempting
                      ? "Downloading or waiting to resume" : "Waiting to download"
                )
                .font(.caption).foregroundStyle(.secondary)
                HStack {
                  if request.state == .failed {
                    Button("Retry") {
                      Task { await workspace.requestDownloads(.document(request.path)) }
                    }
                  }
                  Button("Cancel download") { Task { await workspace.cancelDownload(request) } }
                }.buttonStyle(.borderless)
              }
            }
          }
        }
        Section("Available on this iPhone") {
          ForEach(inventory.documents) { note in
            HStack {
              VStack(alignment: .leading) {
                Text(note.path)
                Text(note.available ? bytes(note.bytes) : "Local file unavailable")
                  .font(.caption).foregroundStyle(.secondary)
              }
              Spacer()
              if note.protections.contains(.pinned) {
                Image(systemName: "pin.fill").accessibilityLabel("Pinned")
              }
            }
            .contextMenu {
              Button("Keep offline", systemImage: "pin") {
                Task { await workspace.requestDownloads(.document(note.path)) }
              }
              if note.evictable {
                Button("Remove download", systemImage: "arrow.up.bin") {
                  Task {
                    do {
                      let storage = try workspace.storageMaintenance()
                      _ = try await storage.evict(
                        [note.path], protecting: workspace.liveDocumentPaths)
                      _ = try await storage.collectGarbage()
                      await workspace.updateStorageInventory()
                    } catch { workspace.error = error.localizedDescription }
                  }
                }
              }
            }
          }
        }
      } else {
        ProgressView("Checking saved files")
      }
      if let usage = workspace.contentUsage {
        Section("Attachments and conversations") {
          LabeledContent("Saved content", value: bytes(usage.totalBytes))
          LabeledContent("Pinned content", value: bytes(usage.pinnedBytes))
          ForEach(workspace.contentInventory, id: \.resource) { entry in
            if case .attachment(let path) = entry.resource {
              HStack {
                VStack(alignment: .leading) {
                  Text(path)
                  if case .available(let metadata) = entry.availability {
                    Text(
                      "\(bytes(metadata.byteCount)) · saved \(metadata.fetchedAt.formatted(date: .abbreviated, time: .shortened))"
                    )
                    .font(.caption).foregroundStyle(.secondary)
                  } else {
                    Text("Not downloaded").font(.caption).foregroundStyle(.secondary)
                  }
                }
                Spacer()
                Button(pinned(entry) ? "Unpin" : "Pin") {
                  Task {
                    do {
                      try await workspace.contentCache.setPinned(entry.resource, !pinned(entry))
                      await workspace.updateStorageInventory()
                    } catch { workspace.error = error.localizedDescription }
                  }
                }.buttonStyle(.borderless)
              }
            }
          }
          Text(
            "Pin conversations and artifacts from their own screens. Opening a downloaded attachment keeps its authenticated bytes available offline."
          )
          .font(.footnote).foregroundStyle(.secondary)
        }
      }
    }
    .navigationTitle("Downloads and storage")
    .task {
      budget = workspace.downloadBudget
      await workspace.updateStorageInventory()
    }
    .refreshable { await workspace.updateStorageInventory() }
    .onChange(of: budget) { _, value in
      workspace.downloadBudget = value
      Task { await workspace.updateStorageInventory() }
    }
  }
  private func bytes(_ value: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file)
  }
  private func label(_ selection: OfflineDownloadSelection) -> String {
    switch selection {
    case .document(let path), .folder(let path): path
    case .allDocuments: "All notes and drawings"
    }
  }
  private func pinned(_ entry: ContentCacheEntry) -> Bool {
    switch entry.availability {
    case .missing(let pinned): pinned
    case .available(let metadata), .tooLarge(let metadata, _): metadata.pinned
    }
  }
  private func failure(_ failure: DocumentDownloadFailure?) -> String {
    switch failure {
    case .tooLarge: "Exceeds the 5 MB download limit"
    case .connectionChanged: "Connection changed · retry on the original host"
    case .storage: "Could not save on this iPhone"
    default: "Could not download · reconnect and retry"
    }
  }
}
