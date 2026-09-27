import DailyDoListDomain
import DailyDoListMobileKit
import DailyDoListModels
import SwiftUI

struct PhoneExplorerView: View {
  @Bindable var workspace: PhoneWorkspace
  @State private var expanded: Set<String> = []
  @State private var query = ""
  @State private var results: [SearchHit] = []
  @State private var coverage = ""
  @State private var searching = false
  @State private var form: PathForm?
  @State private var path = ""
  @State private var trash: VaultTreeRow?

  private enum PathForm: Identifiable {
    case note, folder
    case rename(VaultTreeRow)
    var id: String { title }
    var title: String {
      switch self {
      case .note: "New note"
      case .folder: "New folder"
      case .rename: "Move or rename"
      }
    }
  }

  var body: some View {
    List {
      if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        ForEach(
          VaultTree.visibleRows(VaultTree.build(workspace.entries), expanded: expanded), id: \.path
        ) { row in
          Button {
            if row.kind == .folder {
              if !expanded.insert(row.path).inserted { expanded.remove(row.path) }
            } else {
              Task { await workspace.open(row.path) }
            }
          } label: {
            Label(
              row.name,
              systemImage: row.kind == .folder
                ? (row.isExpanded ? "folder.fill" : "folder") : "doc.text"
            )
            .foregroundStyle(Color.primary).padding(.leading, CGFloat(row.depth) * 16)
          }
          .contextMenu {
            if row.kind == .file {
              Button("Open in new tab", systemImage: "plus.square.on.square") {
                Task { await workspace.open(row.path, newTab: true) }
              }
            }
            Button("Move or rename", systemImage: "pencil") {
              path = row.path
              form = .rename(row)
            }
            .disabled(!workspace.online || workspace.structuralBusy)
            Button("Move to Trash", systemImage: "trash", role: .destructive) { trash = row }
              .disabled(!workspace.online || workspace.structuralBusy)
          }
          .accessibilityAction(named: "Move or rename") {
            guard workspace.online, !workspace.structuralBusy else { return }
            path = row.path
            form = .rename(row)
          }
          .accessibilityAction(named: "Move to Trash") {
            guard workspace.online, !workspace.structuralBusy else { return }
            trash = row
          }

        }
      } else {
        Section {
          ForEach(Array(results.enumerated()), id: \.offset) { _, hit in
            Button {
              Task { await workspace.open(hit.path, line: hit.kind == .content ? hit.line : nil) }
            } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text(hit.path).font(.headline)
                if hit.kind == .content {
                  Text("Line \(hit.line + 1) · \(hit.preview)").font(.subheadline).foregroundStyle(
                    .secondary
                  ).lineLimit(3)
                }
              }.foregroundStyle(Color.primary)
            }
          }
          if results.isEmpty && !searching { Text("No matches").foregroundStyle(.secondary) }
        } header: {
          Text(coverage)
        }
      }
    }
    .navigationTitle("Notes")
    .searchable(text: $query, prompt: "Search notes and contents")
    .textInputAutocapitalization(.never)
    .autocorrectionDisabled()
    .task(id: SearchRequest(query: query, online: workspace.online)) { await search() }
    .refreshable { await workspace.refreshTree() }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu("Create", systemImage: "plus") {
          Button("New note", systemImage: "doc.badge.plus") {
            path = ""
            form = .note
          }
          Button("New folder", systemImage: "folder.badge.plus") {
            path = ""
            form = .folder
          }.disabled(!workspace.online)
        }
      }
    }
    .sheet(item: $form) { action in
      NavigationStack {
        Form {
          TextField("Folder/Name", text: $path).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Text("Use a relative path inside this workspace.").font(.footnote).foregroundStyle(
            .secondary)
        }
        .navigationTitle(action.title)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { form = nil } }
          ToolbarItem(placement: .confirmationAction) {
            Button("Save") {
              let requested = path
              form = nil
              Task {
                switch action {
                case .note: await workspace.createNote(requested)
                case .folder: await workspace.createFolder(requested)
                case .rename(let row):
                  await workspace.changeStructure(
                    .rename(from: row.path, to: requested, isFolder: row.kind == .folder))
                }
              }
            }.disabled(path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }
      }.presentationDetents([.medium, .large])
    }
    .confirmationDialog(
      "Move to Trash?",
      isPresented: Binding(get: { trash != nil }, set: { if !$0 { trash = nil } }),
      titleVisibility: .visible
    ) {
      if let row = trash {
        Button("Move \(row.name) to Trash", role: .destructive) {
          trash = nil
          Task {
            await workspace.changeStructure(.trash(path: row.path, isFolder: row.kind == .folder))
          }
        }
      }
    } message: {
      Text("The host keeps deleted files in the vault’s .trash folder.")
    }
  }

  private func search() async {
    let request = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !request.isEmpty else {
      results = []
      return
    }
    searching = true
    defer {
      if query.trimmingCharacters(in: .whitespacesAndNewlines) == request { searching = false }
    }
    do {
      try await Task.sleep(for: .milliseconds(150))
      let local = try await workspace.repository.search(request)
      try Task.checkCancellation()
      results = local.hits
      coverage = "Downloaded notes (\(local.downloadedNotes))"
      if let client = workspace.client, workspace.online {
        let remote = try await client.search(request, limit: 100)
        try Task.checkCancellation()
        let dirty = Set(
          try await workspace.repository.notes().filter { $0.state != .synced }.map(\.path))
        results = Array(
          (local.hits.filter { dirty.contains($0.path) }
            + remote.hits.filter { !dirty.contains($0.path) }).prefix(100))
        coverage = "Entire vault · includes unsynced iPhone edits"
      }
    } catch is CancellationError {
    } catch { coverage = "Downloaded notes · host search unavailable" }
  }

  private struct SearchRequest: Hashable {
    let query: String
    let online: Bool
  }
}
