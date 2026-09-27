import SwiftUI
import UIKit

/// Completion comes from the actual Files copy operation, never from sheet dismissal.
struct WorkspaceExportPicker: UIViewControllerRepresentable {
  let url: URL
  let completed: @MainActor (URL?) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(completed: completed) }
  func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
    let controller = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
    controller.delegate = context.coordinator
    return controller
  }
  func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

  @MainActor final class Coordinator: NSObject, UIDocumentPickerDelegate {
    private let completed: @MainActor (URL?) -> Void
    private var delivered = false
    init(completed: @escaping @MainActor (URL?) -> Void) { self.completed = completed }
    func documentPicker(
      _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
    ) {
      finish(urls.count == 1 ? urls[0] : nil)
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(nil) }
    private func finish(_ url: URL?) {
      guard !delivered else { return }
      delivered = true
      completed(url)
    }
  }
}
