#if canImport(UIKit)
  import Observation
  import SwiftUI
  import UniformTypeIdentifiers

  /// Device-local reusable shapes. Inject a separate defaults suite for tests or app profiles.
  @MainActor
  @Observable
  public final class MobileDrawingLibrary {
    public static let shared = MobileDrawingLibrary()
    public private(set) var items: [DrawingLibraryItem] = []
    public private(set) var error: String?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let key: String
    public init(defaults: UserDefaults = .standard, key: String = "drawing.library.v1") {
      self.defaults = defaults
      self.key = key
      guard let data = defaults.data(forKey: key) else { return }
      do { items = try DrawingLibraryCodec.decode(data) } catch {
        self.error =
          "The saved library could not be read. Export its original data before resetting it."
      }
    }
    public var exportData: Data {
      error == nil ? DrawingLibraryCodec.encode(items) : defaults.data(forKey: key) ?? Data()
    }
    public func add(_ scene: ExcalidrawScene, name: String) throws {
      guard error == nil else { throw DrawingTransferError.invalid }
      try save(
        items + [DrawingLibraryItem(name: name.isEmpty ? "Saved shapes" : name, scene: scene)])
    }
    public func remove(_ id: String) throws { try save(items.filter { $0.id != id }) }
    public func importData(_ data: Data) throws {
      guard error == nil else { throw DrawingTransferError.invalid }
      var known = Set(items.map(\.id))
      let imported = try DrawingLibraryCodec.decode(data).map { item in
        var value = item
        if !known.insert(value.id).inserted {
          value.id = UUID().uuidString
          known.insert(value.id)
        }
        return value
      }
      try save(items + imported)
    }
    public func reset() {
      items = []
      error = nil
      defaults.removeObject(forKey: key)
    }
    private func save(_ values: [DrawingLibraryItem]) throws {
      guard error == nil else { throw DrawingTransferError.invalid }
      let data = DrawingLibraryCodec.encode(values)
      guard values.count <= 1000, data.count <= DrawingClipboard.maximumBytes else {
        throw DrawingTransferError.tooLarge
      }
      defaults.set(data, forKey: key)
      items = values
    }
  }

  struct DrawingLibraryDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json, .data] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
      data = configuration.file.regularFileContents ?? Data()
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
      FileWrapper(regularFileWithContents: data)
    }
  }

  struct MobileDrawingLibraryView: View {
    let controller: MobileDrawingController
    @State private var name = ""
    @State private var importing = false
    @State private var exporting = false
    @State private var resetting = false
    @State private var error: String?
    var body: some View {
      List {
        if let problem = controller.library.error {
          Section { Text(problem).foregroundStyle(.red) }
        }
        Section("Save selection") {
          TextField("Shape name", text: $name)
          Button("Add selection to library") {
            perform {
              guard let scene = controller.editor.copiedScene() else { return }
              try controller.library.add(scene, name: name)
              name = ""
            }
          }.disabled(controller.editor.selectedIds.isEmpty || controller.library.error != nil)
        }
        Section("Device library") {
          ForEach(controller.library.items) { item in
            HStack {
              if let image = DrawingImage.render(
                item.scene, scale: 0.5, theme: .light, background: .transparent)
              {
                Image(uiImage: UIImage(cgImage: image)).resizable().scaledToFit().frame(
                  width: 64, height: 44)
              }
              Button(item.name) {
                perform {
                  _ = try controller.editor.paste(item.scene, at: controller.insertionPoint)
                }
              }
              .accessibilityHint("Insert these shapes into the drawing")
              Spacer()
              Button(role: .destructive) {
                perform { try controller.library.remove(item.id) }
              } label: {
                Image(systemName: "trash")
              }.accessibilityLabel("Remove \(item.name) from library")
            }
          }
          if controller.library.items.isEmpty { Text("No saved shapes.") }
        }
        Section {
          Button("Import library file") { importing = true }.disabled(
            controller.library.error != nil)
          Button("Export library") { exporting = true }
          Button("Browse Excalidraw libraries") {
            controller.onOpenLink?("https://libraries.excalidraw.com")
          }
          .disabled(controller.onOpenLink == nil)
          Button("Reset device library", role: .destructive) { resetting = true }
          Text(
            "The library stays on this device. Import and export .excalidrawlib or JSON library files to move shapes between devices. Nothing is published or downloaded automatically."
          ).font(.footnote)
          if let error { Text(error).foregroundStyle(.red) }
        }
      }
      .navigationTitle("Shape library")
      .fileImporter(isPresented: $importing, allowedContentTypes: [.json, .data]) { result in
        perform {
          let url = try result.get()
          let access = url.startAccessingSecurityScopedResource()
          defer { if access { url.stopAccessingSecurityScopedResource() } }
          guard
            (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
              <= DrawingClipboard.maximumBytes
          else { throw DrawingTransferError.tooLarge }
          try controller.library.importData(Data(contentsOf: url, options: .mappedIfSafe))
        }
      }
      .fileExporter(
        isPresented: $exporting,
        document: DrawingLibraryDocument(data: controller.library.exportData), contentType: .json,
        defaultFilename: "Drawing shapes.excalidrawlib"
      ) { result in
        if case .failure(let failure) = result { error = failure.localizedDescription }
      }
      .alert("Reset the device's shape library?", isPresented: $resetting) {
        Button("Reset", role: .destructive) { controller.library.reset() }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text("Saved library items are removed. Shapes already inserted in drawings remain.")
      }
    }
    private func perform(_ operation: () throws -> Void) {
      do {
        try operation()
        error = nil
      } catch { self.error = error.localizedDescription }
    }
  }
#endif
