import SwiftUI
import VisionKit

/// VisionKit handles the camera preview and QR recognition; recognition only fills a form.
struct PairingScanner: UIViewControllerRepresentable {
  let receive: (String) -> Void
  let failed: (String) -> Void

  func makeUIViewController(context: Context) -> ScannerHost {
    ScannerHost(receive: receive, failed: failed)
  }
  func updateUIViewController(_ controller: ScannerHost, context: Context) {}

  @MainActor
  final class ScannerHost: UIViewController, DataScannerViewControllerDelegate {
    private let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighFrameRateTrackingEnabled: false,
      isHighlightingEnabled: true)
    private let receive: (String) -> Void
    private let failed: (String) -> Void
    private var delivered = false

    init(receive: @escaping (String) -> Void, failed: @escaping (String) -> Void) {
      self.receive = receive
      self.failed = failed
      super.init(nibName: nil, bundle: nil)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("Use init(receive:failed:)") }

    override func viewDidLoad() {
      super.viewDidLoad()
      scanner.delegate = self
      addChild(scanner)
      scanner.view.frame = view.bounds
      scanner.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      view.addSubview(scanner.view)
      scanner.didMove(toParent: self)
    }

    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      do { try scanner.startScanning() } catch {
        failed("Camera scanning is unavailable. Enter the address and pairing code instead.")
      }
    }

    override func viewWillDisappear(_ animated: Bool) {
      scanner.stopScanning()
      super.viewWillDisappear(animated)
    }

    func dataScanner(
      _ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem],
      allItems: [RecognizedItem]
    ) {
      for case .barcode(let barcode) in addedItems {
        guard !delivered, let value = barcode.payloadStringValue else { continue }
        delivered = true
        dataScanner.stopScanning()
        receive(value)
      }
    }

    func dataScanner(
      _ dataScanner: DataScannerViewController,
      becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
    ) {
      failed("Camera scanning stopped. Enter the address and pairing code instead.")
    }
  }
}
