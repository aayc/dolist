#if canImport(UIKit)
  import SwiftUI
  import UIKit

  /// Renders PDF pages without evaluating annotations/actions. Sharing uses the original bytes.
  public struct MobileAttachmentPreviewView: View {
    public let attachment: MobileEditorAttachment
    private let identity: String
    @State private var preview: MobileAttachmentPreview?
    @State private var page = 1
    @State private var failed = false
    @State private var sharing = false
    public init(attachment: MobileEditorAttachment, identity: String) {
      self.attachment = attachment
      self.identity = identity
    }
    public var body: some View {
      VStack {
        if let preview {
          AttachmentZoom(image: UIImage(cgImage: preview.image))
        } else if failed {
          ContentUnavailableView(
            "Preview unavailable", systemImage: "doc",
            description: Text("The original file can still be saved or shared."))
        } else {
          ProgressView("Loading preview")
        }
        if let preview, preview.pageCount > 1 {
          HStack {
            Button("Previous") { page -= 1 }.disabled(page <= 1)
            Spacer()
            Text("\(page) of \(preview.pageCount)")
            Spacer()
            Button("Next") { page += 1 }.disabled(page >= preview.pageCount)
          }.padding()
        }
      }
      .navigationTitle((attachment.path as NSString).lastPathComponent)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { Button("Share", systemImage: "square.and.arrow.up") { sharing = true } }
      .task(id: page) {
        let result = await MobileAttachmentDecoder.shared.preview(
          attachment, identity: identity, page: page)
        guard !Task.isCancelled else { return }
        preview = result
        failed = result == nil
      }
      .sheet(isPresented: $sharing) { AttachmentShare(attachment: attachment) }
    }
  }

  private struct AttachmentZoom: UIViewRepresentable {
    let image: UIImage
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIScrollView {
      let view = UIScrollView()
      view.minimumZoomScale = 1
      view.maximumZoomScale = 5
      view.delegate = context.coordinator
      context.coordinator.image.contentMode = .scaleAspectFit
      context.coordinator.image.accessibilityLabel = "Attachment preview"
      context.coordinator.image.isAccessibilityElement = true
      view.addSubview(context.coordinator.image)
      return view
    }
    func updateUIView(_ view: UIScrollView, context: Context) {
      context.coordinator.image.image = image
      context.coordinator.image.frame = view.bounds
      context.coordinator.image.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      view.contentSize = view.bounds.size
    }
    final class Coordinator: NSObject, UIScrollViewDelegate {
      let image = UIImageView()
      func viewForZooming(in scrollView: UIScrollView) -> UIView? { image }
    }
  }

  private struct AttachmentShare: UIViewControllerRepresentable {
    let attachment: MobileEditorAttachment
    func makeUIViewController(context: Context) -> UIActivityViewController {
      UIActivityViewController(
        activityItems: [AttachmentShareItem(attachment)], applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
  }

  @MainActor private final class AttachmentShareItem: NSObject, @preconcurrency UIActivityItemSource
  {
    let attachment: MobileEditorAttachment
    init(_ attachment: MobileEditorAttachment) { self.attachment = attachment }
    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController)
      -> Any
    { attachment.data }
    func activityViewController(
      _ activityViewController: UIActivityViewController,
      itemForActivityType activityType: UIActivity.ActivityType?
    ) -> Any? { attachment.data }
    func activityViewController(
      _ activityViewController: UIActivityViewController,
      subjectForActivityType activityType: UIActivity.ActivityType?
    ) -> String { (attachment.path as NSString).lastPathComponent }
  }

  extension MobileEmbedCoordinator {
    func presentAttachment(_ attachment: MobileEditorAttachment) {
      guard let presenter = owner?.input.owningViewController,
        presenter.presentedViewController == nil
      else { return }
      let controller = UIHostingController(
        rootView: NavigationStack {
          MobileAttachmentPreviewView(attachment: attachment, identity: identity)
        })
      presenter.present(controller, animated: true)
    }
  }
#endif
