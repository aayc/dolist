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

    public var body: some View {
      Group {
        if let error {
          ContentUnavailableView {
            Label("Couldn't open artifact", systemImage: "exclamationmark.triangle")
          } description: {
            Text(error)
          } actions: {
            Button("Try again") { Task { await load() } }
          }
        } else if let payload {
          preview(payload)
        } else {
          ProgressView("Loading artifact…")
        }
      }
      .navigationTitle(meta.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
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
        contentType: UTType(mimeType: meta.mimeType) ?? .data,
        defaultFilename: ArtifactFiles.fileName(
          meta: meta, kind: meta.kind, mimeType: meta.mimeType)
      ) { result in
        if case .failure(let problem) = result { error = problem.localizedDescription }
      }
      .task(id: meta.id) { await load() }
      .sheet(isPresented: $sharing) {
        if let payload { MobileArtifactShare(data: payload.data) }
      }
    }

    @ViewBuilder private func preview(_ payload: ArtifactPayload) -> some View {
      switch meta.kind {
      case .markdown:
        ScrollView {
          MobileMarkdownView(source: ArtifactFiles.text(of: payload), openNote: openNote).padding()
        }
      case .html:
        MobileHTMLArtifact(html: ArtifactFiles.text(of: payload))
      case .image:
        if let image { MobileZoomableImage(image: image, label: meta.title) } else { unavailable }
      case .code, .json, .text:
        ScrollView {
          if meta.kind == .text {
            Text(ArtifactFiles.text(of: payload)).textSelection(.enabled).frame(
              maxWidth: .infinity, alignment: .leading
            ).padding()
          } else {
            MobileJSONView(
              text: meta.kind == .json
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

    private func load() async {
      error = nil
      payload = nil
      image = nil
      guard meta.size <= MobileImageDecoder.maximumBytes else {
        error = "This artifact exceeds the 32 MB phone preview limit. Open it on the host."
        return
      }
      do {
        let fetched = try await store.fetchArtifact(threadId: meta.threadId, artifactId: meta.id)
        guard !Task.isCancelled else { return }
        guard fetched.data.count <= MobileImageDecoder.maximumBytes else {
          error = "This artifact exceeds the 32 MB phone preview limit."
          return
        }
        if meta.kind == .image, let decoded = await MobileImageDecoder.shared.decode(fetched.data),
          !Task.isCancelled
        {
          image = UIImage(cgImage: decoded.image)
        }
        if !Task.isCancelled { payload = fetched }
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
