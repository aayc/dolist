import DailyDoListDrawingCore
import Foundation
import Observation

public enum MobileDrawingLibraryError: LocalizedError, Equatable, Sendable {
  case unavailable, unverifiedMove
  public var errorDescription: String? {
    switch self {
    case .unavailable: "The shape library can't change until the problem shown above is resolved."
    case .unverifiedMove: "Its protected copy could not be verified."
    }
  }
}

/// Device-local reusable shapes. The app injects persistence inside its managed storage; the
/// library reads it on first use and writes the whole library on every change. Without injected
/// storage nothing leaves memory.
@MainActor
@Observable
public final class MobileDrawingLibrary {
  /// One serialized library. `save` must replace it atomically and durably.
  public struct Storage {
    public var load: () throws -> Data?
    public var save: (Data) throws -> Void
    public init(load: @escaping () throws -> Data?, save: @escaping (Data) throws -> Void) {
      self.load = load
      self.save = save
    }
    public static func memory() -> Storage {
      let box = MemoryBox()
      return Storage(load: { box.data }, save: { box.data = $0 })
    }
    private final class MemoryBox { var data: Data? }
  }

  /// Where earlier versions kept the library: app preferences, outside managed storage.
  public struct LegacyStorage {
    public var load: () -> Data?
    public var remove: () -> Void
    public init(load: @escaping () -> Data?, remove: @escaping () -> Void) {
      self.load = load
      self.remove = remove
    }
    public static func userDefaults(_ defaults: UserDefaults, key: String = "drawing.library.v1")
      -> LegacyStorage
    {
      LegacyStorage(
        load: { defaults.data(forKey: key) }, remove: { defaults.removeObject(forKey: key) })
    }
  }

  public private(set) var items: [DrawingLibraryItem] = []
  public private(set) var error: String?
  @ObservationIgnored private let storage: Storage
  @ObservationIgnored private let legacy: LegacyStorage?
  @ObservationIgnored private var loaded = false
  /// Bytes the library could not read or move, exported verbatim.
  @ObservationIgnored private var original: Data?

  public init(storage: Storage, legacy: LegacyStorage? = nil) {
    self.storage = storage
    self.legacy = legacy
  }

  /// Reads the library on first use, and again after a failure (a locked device, a failed move).
  /// A legacy copy is removed only once storage returns exactly its bytes after saving them;
  /// until then it stays, and its shapes remain insertable and exportable.
  public func loadIfNeeded() {
    guard !loaded else { return }
    let old = legacy?.load()
    let data: Data?
    do {
      var stored = try storage.load()
      if let old {
        if stored == nil {
          try storage.save(old)
          stored = try storage.load()
        }
        guard stored == old else { throw MobileDrawingLibraryError.unverifiedMove }
        legacy?.remove()
      }
      data = stored
    } catch {
      items = old.flatMap { try? DrawingLibraryCodec.decode($0) } ?? []
      original = old
      self.error =
        old == nil
        ? "The shape library could not be read. \(error.localizedDescription)"
        : "The shape library could not be moved into protected storage, so its earlier copy was kept on this device. \(error.localizedDescription)"
      return
    }
    loaded = true
    do {
      items = try data.map(DrawingLibraryCodec.decode) ?? []
      original = nil
      error = nil
    } catch {
      items = []
      original = data
      self.error =
        "The saved library could not be read. Export its original data before resetting it."
    }
  }

  public var exportData: Data { original ?? DrawingLibraryCodec.encode(items) }

  public func add(_ scene: ExcalidrawScene, name: String) throws {
    // More elements than an item may hold would make the whole library unreadable next time.
    guard scene.elements.count <= 10_000 else { throw DrawingTransferError.tooLarge }
    try update {
      $0 + [DrawingLibraryItem(name: name.isEmpty ? "Saved shapes" : name, scene: scene)]
    }
  }
  public func remove(_ id: String) throws { try update { $0.filter { $0.id != id } } }
  public func importData(_ data: Data) throws {
    let imported = try DrawingLibraryCodec.decode(data)
    try update { items in
      var known = Set(items.map(\.id))
      return items
        + imported.map { item in
          var value = item
          if !known.insert(value.id).inserted {
            value.id = UUID().uuidString
            known.insert(value.id)
          }
          return value
        }
    }
  }
  /// Replaces every copy, the legacy one included, with an empty library.
  public func reset() throws {
    try storage.save(DrawingLibraryCodec.encode([]))
    legacy?.remove()
    items = []
    original = nil
    error = nil
    loaded = true
  }
  private func update(_ change: ([DrawingLibraryItem]) throws -> [DrawingLibraryItem]) throws {
    loadIfNeeded()
    guard error == nil else { throw MobileDrawingLibraryError.unavailable }
    let values = try change(items)
    let data = DrawingLibraryCodec.encode(values)
    guard values.count <= 1000, data.count <= DrawingClipboard.maximumBytes else {
      throw DrawingTransferError.tooLarge
    }
    try storage.save(data)
    items = values
  }
}

#if canImport(UIKit)
  import SwiftUI
  import UniformTypeIdentifiers

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
                  controller.finishEditing()
                  try controller.insertShapes(item.scene, at: controller.insertionPoint)
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
      .onAppear { controller.library.loadIfNeeded() }
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
        Button("Reset", role: .destructive) { perform { try controller.library.reset() } }
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
