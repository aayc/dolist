#if canImport(UIKit)
  import DailyDoListEditorCore
  import Observation
  import SwiftUI

  @MainActor @Observable
  public final class MobileBacklinksModel {
    public private(set) var identity = ""
    public private(set) var notePath = ""
    public private(set) var snapshot: EditorBacklinksSnapshot?
    public private(set) var loading = false
    public private(set) var error: String?
    private var generation = 0
    public init() {}

    public func load(
      identity: String, notePath: String,
      source: @MainActor (String) async throws -> EditorBacklinksSnapshot
    ) async {
      generation += 1
      let generation = generation
      if self.identity != identity || self.notePath != notePath { snapshot = nil }
      self.identity = identity
      self.notePath = notePath
      error = nil
      loading = true
      defer { if generation == self.generation { loading = false } }
      do {
        let result = try await source(notePath)
        guard generation == self.generation, !Task.isCancelled else { return }
        // Duplicate index rows cannot cause duplicate SwiftUI identities or repeat navigation.
        var seen: Set<String> = []
        snapshot = EditorBacklinksSnapshot(
          mentions: result.mentions.filter { seen.insert($0.id).inserted },
          coverage: result.coverage)
      } catch {
        guard generation == self.generation, !Task.isCancelled else { return }
        if snapshot != nil { snapshot?.coverage = .cached(updatedAt: nil) }
        self.error = "Backlinks could not be loaded. Try again when the host is available."
      }
    }
  }

  /// Linked and unlinked mentions with honest cache coverage. The host owns querying, offline
  /// storage and navigation; changing identity prevents previous-vault results from appearing.
  public struct MobileBacklinksView: View {
    private let notePath: String
    private let identity: String
    private let source: @MainActor (String) async throws -> EditorBacklinksSnapshot
    private let onOpen: @MainActor (String, Int) -> Void
    @State private var model = MobileBacklinksModel()
    public init(
      notePath: String, identity: String,
      source: @escaping @MainActor (String) async throws -> EditorBacklinksSnapshot,
      onOpen: @escaping @MainActor (String, Int) -> Void
    ) {
      self.notePath = notePath
      self.identity = identity
      self.source = source
      self.onOpen = onOpen
    }
    public var body: some View {
      List {
        if model.identity == identity, model.notePath == notePath {
          if let snapshot = model.snapshot {
            coverage(snapshot.coverage)
            mentions(
              snapshot.mentions.filter { $0.kind == .linked }, title: "Linked mentions",
              complete: snapshot.coverage == .complete)
            mentions(
              snapshot.mentions.filter { $0.kind == .unlinked }, title: "Unlinked mentions",
              complete: snapshot.coverage == .complete)
          }
          if let error = model.error { Section { Text(error).foregroundStyle(.secondary) } }
          if model.loading { ProgressView("Loading backlinks") }
        } else {
          ProgressView("Loading backlinks")
        }
      }
      .navigationTitle("Backlinks")
      .navigationBarTitleDisplayMode(.inline)
      .task(id: identity + "\u{0}" + notePath) { await reload() }
      .refreshable { await reload() }
      .toolbar {
        Button("Refresh", systemImage: "arrow.clockwise") { Task { await reload() } }.disabled(
          model.loading)
      }
    }
    private func reload() async {
      await model.load(identity: identity, notePath: notePath, source: source)
    }
    @ViewBuilder private func coverage(_ coverage: EditorBacklinksSnapshot.Coverage) -> some View {
      switch coverage {
      case .complete: EmptyView()
      case .partial:
        Section {
          Text("Partial results. Some notes have not been searched.").font(.footnote)
            .foregroundStyle(.secondary)
        }
      case .cached(let date):
        Section {
          if let date {
            Text("Cached results · \(date.formatted(date: .abbreviated, time: .shortened))").font(
              .footnote
            ).foregroundStyle(.secondary)
          } else {
            Text("Cached results. Newer mentions may be missing.").font(.footnote).foregroundStyle(
              .secondary)
          }
        }
      }
    }
    private func mentions(_ mentions: [EditorBacklinkMention], title: String, complete: Bool)
      -> some View
    {
      Section("\(title) (\(mentions.count))") {
        if mentions.isEmpty {
          Text(complete ? "No mentions" : "No mentions in the available results").foregroundStyle(
            .secondary)
        }
        ForEach(mentions) { mention in
          Button {
            onOpen(mention.path, mention.line)
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(mention.path).font(.subheadline.weight(.semibold))
                Spacer()
                Text("Line \(mention.line + 1)").font(.caption).foregroundStyle(.secondary)
              }
              Text(mention.context).font(.callout).foregroundStyle(.secondary).lineLimit(4)
            }.frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(.plain)
          .accessibilityHint("Open note at this mention")
        }
      }
    }
  }
#endif
