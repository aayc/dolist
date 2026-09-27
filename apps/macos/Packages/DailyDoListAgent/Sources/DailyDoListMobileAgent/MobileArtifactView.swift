#if canImport(UIKit)
  import DailyDoListAgentCore
  import DailyDoListClient
  import DailyDoListModels
  import PDFKit
  import SwiftUI
  import UniformTypeIdentifiers
  import WebKit

  /// Authenticated bytes are fetched through the daemon client. Preview engines receive only
  /// these bytes, with no credential, network access or JavaScript bridge.
  public struct MobileArtifactView: View {
    let store: AgentStore
    let meta: ArtifactMeta
    let openNote: (String, Int?) -> Void
    @State private var payload: ArtifactPayload?
    @State private var loadedMeta: ArtifactMeta?
    @State private var fromCache = false
    @State private var savedOffline = false
    @State private var fetchedAt: Date?
    @State private var loading = false
    @State private var image: UIImage?
    @State private var error: String?
    @State private var exporting = false
    @State private var sharing = false
    @Environment(\.dismiss) private var dismiss

    public init(
      store: AgentStore, meta: ArtifactMeta,
      openNote: @escaping (String, Int?) -> Void = { _, _ in }
    ) {
      self.store = store
      self.meta = meta
      self.openNote = openNote
    }

    private var resource: AgentCacheResource {
      .artifact(threadID: meta.threadId, artifactID: meta.id)
    }
    private var displayMeta: ArtifactMeta { loadedMeta ?? meta }

    public var body: some View {
      Group {
        if let payload {
          VStack(spacing: 8) {
            if let error {
              Text(error).font(.caption).foregroundStyle(.secondary).padding(.horizontal)
            }
            if let fetchedAt {
              HStack {
                Label(
                  savedOffline ? (fromCache ? "Saved copy" : "Downloaded") : "Preview only",
                  systemImage: fromCache ? "iphone" : "arrow.down.circle")
                Text(fetchedAt, style: .relative) + Text(" ago")
                Spacer()
                if savedOffline, store.cacheAvailability[resource]?.pinned == true {
                  Image(systemName: "pin.fill")
                }
              }.font(.caption).foregroundStyle(.secondary).padding(.horizontal)
            }
            if store.hasContentCache, !savedOffline {
              Text("This preview was not saved offline.")
                .font(.caption).foregroundStyle(.secondary)
            }
            preview(payload).id(fetchedAt)
          }
        } else if let error {
          ContentUnavailableView {
            Label("Couldn't open artifact", systemImage: "exclamationmark.triangle")
          } description: {
            Text(error)
          } actions: {
            Button("Try again") { Task { await load(refresh: true) } }.disabled(
              !store.canFetchContent)
          }
        } else {
          ProgressView("Loading artifact…")
        }
      }
      .navigationTitle(displayMeta.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        ToolbarItem(placement: .topBarLeading) {
          Menu("Download options", systemImage: "ellipsis.circle") {
            Button("Refresh download", systemImage: "arrow.clockwise") {
              Task { await load(refresh: true) }
            }.disabled(!store.canFetchContent || loading)
            if store.hasContentCache {
              let pinned = store.cacheAvailability[resource]?.pinned ?? false
              Button(
                pinned ? "Remove offline pin" : "Keep offline",
                systemImage: pinned ? "pin.slash" : "pin"
              ) {
                Task {
                  await store.setContentPinned(resource, pinned: !pinned)
                  if !pinned, store.canFetchContent {
                    _ = await store.downloadArtifact(threadID: meta.threadId, artifactID: meta.id)
                    await load()
                  }
                }
              }.disabled(loading)
            }
          }
        }
        ToolbarItem(placement: .bottomBar) {
          HStack {
            Button("Save to Files", systemImage: "square.and.arrow.down") { exporting = true }
            Spacer()
            Button("Share", systemImage: "square.and.arrow.up") { sharing = true }
          }.disabled(payload == nil)
        }
      }
      .fileExporter(
        isPresented: $exporting, document: payload.map { ArtifactDocument(data: $0.data) },
        contentType: UTType(mimeType: displayMeta.mimeType) ?? .data,
        defaultFilename: ArtifactFiles.fileName(
          meta: displayMeta, kind: displayMeta.kind, mimeType: displayMeta.mimeType)
      ) { result in
        if case .failure(let problem) = result { error = problem.localizedDescription }
      }
      .task(id: meta.id) {
        await store.refreshCacheAvailability(resource)
        await load()
      }
      .sheet(isPresented: $sharing) {
        if let payload { MobileArtifactShare(data: payload.data) }
      }
    }

    @ViewBuilder private func preview(_ payload: ArtifactPayload) -> some View {
      switch displayMeta.kind {
      case .markdown:
        ScrollView {
          MobileMarkdownView(source: ArtifactFiles.text(of: payload), openNote: openNote).padding()
        }
      case .html:
        MobileHTMLArtifact(html: ArtifactFiles.text(of: payload))
      case .image:
        if let image {
          MobileZoomableImage(image: image, label: displayMeta.title)
        } else {
          unavailable
        }
      case .code, .json, .text:
        ScrollView {
          if displayMeta.kind == .text {
            Text(ArtifactFiles.text(of: payload)).textSelection(.enabled).frame(
              maxWidth: .infinity, alignment: .leading
            ).padding()
          } else {
            MobileJSONView(
              text: displayMeta.kind == .json
                ? ArtifactFiles.prettyJSON(payload.data) ?? ArtifactFiles.text(of: payload)
                : ArtifactFiles.text(of: payload)
            ).padding()
          }
        }
      default:
        if payload.mimeType.split(separator: ";").first == "application/pdf" {
          MobilePDFArtifact(data: payload.data)
        } else {
          unavailable
        }
      }
    }

    private var unavailable: some View {
      ContentUnavailableView(
        "No preview", systemImage: "doc",
        description: Text("Save this file to open it in an app you choose."))
    }

    private func load(refresh: Bool = false) async {
      guard !loading else { return }
      loading = true
      defer { loading = false }
      error = nil
      do {
        let result = try await store.loadArtifact(
          threadID: meta.threadId, artifactID: meta.id, refresh: refresh)
        guard !Task.isCancelled else { return }
        var decodedImage: UIImage?
        if result.value.artifact.kind == .image,
          let decoded = await MobileImageDecoder.shared.decode(result.value.payload.data),
          !Task.isCancelled
        {
          decodedImage = UIImage(cgImage: decoded.image)
        }
        guard !Task.isCancelled else { return }
        image = decodedImage
        loadedMeta = result.value.artifact
        payload = result.value.payload
        fromCache = result.fromCache
        savedOffline = result.savedOffline
        fetchedAt = result.fetchedAt
      } catch {
        if !Task.isCancelled { self.error = AgentAlert.describe(error) }
      }
    }
  }

  private struct MobileArtifactShare: UIViewControllerRepresentable {
    let data: Data
    func makeUIViewController(context: Context) -> UIActivityViewController {
      UIActivityViewController(activityItems: [data], applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
  }

  private struct ArtifactDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.data]
    let data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
      data = configuration.file.regularFileContents ?? Data()
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
      FileWrapper(regularFileWithContents: data)
    }
  }

  private struct MobilePDFArtifact: UIViewRepresentable {
    let data: Data
    func makeUIView(context: Context) -> PDFView {
      let view = PDFView()
      view.autoScales = true
      view.document = PDFDocument(data: data)
      view.delegate = context.coordinator
      return view
    }
    func updateUIView(_ uiView: PDFView, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, PDFViewDelegate {
      func pdfViewWillClick(onLink sender: PDFView, with url: URL) {}
    }
  }

  private struct MobileHTMLArtifact: UIViewRepresentable {
    let html: String
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView {
      let configuration = WKWebViewConfiguration()
      configuration.websiteDataStore = .nonPersistent()
      configuration.defaultWebpagePreferences.allowsContentJavaScript = false
      configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
      let view = WKWebView(frame: .zero, configuration: configuration)
      view.navigationDelegate = context.coordinator
      view.allowsLinkPreview = false
      view.loadHTMLString(HTMLArtifactPolicy.document(for: html), baseURL: nil)
      return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    final class Coordinator: NSObject, WKNavigationDelegate {
      private var hasLoaded = false
      func webView(
        _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
      ) {
        decisionHandler(
          HTMLArtifactPolicy.allowsNavigation(
            to: action.request.url,
            isMainFrame: action.targetFrame?.isMainFrame == true, hasLoaded: hasLoaded)
            ? .allow : .cancel)
      }
      func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { hasLoaded = true }
    }
  }
#endif
