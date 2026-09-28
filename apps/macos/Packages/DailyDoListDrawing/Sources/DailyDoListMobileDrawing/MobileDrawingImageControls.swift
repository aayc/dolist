#if canImport(UIKit)
  import PhotosUI
  import SwiftUI
  import UniformTypeIdentifiers

  struct MobileDrawingImageControls: View {
    let controller: MobileDrawingController
    @State private var photo: PhotosPickerItem?
    @State private var importingFile = false
    @State private var choosingPhoto = false
    @State private var imports = DrawingImageImportSession()
    @State private var photoRequest: DrawingImageImportSession.Request?
    @State private var fileRequest: DrawingImageImportSession.Request?
    @State private var cropping: String?

    private var selectedImage: ExcalidrawElement? {
      let selected = controller.editor.selectedElements
      return selected.count == 1 && selected[0].type == .image ? selected[0] : nil
    }

    var body: some View {
      Menu {
        Button("Insert photo") { choosePhoto(replacing: nil) }
        Button("Insert image file") { chooseFile(replacing: nil) }
        if let selectedImage {
          Button("Replace image from photos") { choosePhoto(replacing: selectedImage.id) }
          Button("Replace image from file") { chooseFile(replacing: selectedImage.id) }
          Button("Crop image") { cropping = selectedImage.id }
          Button("Reset crop") { controller.editor.cropImage(selectedImage.id, rect: nil) }
        }
      } label: {
        Image(systemName: "photo").frame(width: 44, height: 44)
      }
      .accessibilityLabel("Images")
      .photosPicker(isPresented: $choosingPhoto, selection: $photo, matching: .images)
      .onChange(of: photo) { _, item in
        guard let item else { return }
        photo = nil
        guard let request = photoRequest else { return }
        photoRequest = nil
        imports.load(request, bytes: { try await item.loadTransferable(type: Data.self) }) {
          data, request in
          try controller.insertImage(data, replacing: request.replacing, at: request.point)
        }
      }
      // Leaving editing (read-only, view or zen mode) removes these controls.
      .onDisappear { imports.cancel() }
      .fileImporter(isPresented: $importingFile, allowedContentTypes: [.image]) { result in
        guard let request = fileRequest else { return }
        fileRequest = nil
        imports.accept(request) {
          let url = try result.get()
          let access = url.startAccessingSecurityScopedResource()
          defer { if access { url.stopAccessingSecurityScopedResource() } }
          let values = try url.resourceValues(forKeys: [.fileSizeKey])
          guard (values.fileSize ?? 0) <= EmbeddedDrawingImages.maximumBytes else {
            throw DrawingImageImportError.unreadable
          }
          try controller.insertImage(
            Data(contentsOf: url, options: .mappedIfSafe), replacing: request.replacing,
            at: request.point)
        }
      }
      .sheet(isPresented: Binding(get: { cropping != nil }, set: { if !$0 { cropping = nil } })) {
        if let id = cropping { MobileDrawingCrop(editor: controller.editor, id: id) }
      }
      .alert(
        "Image could not be inserted",
        isPresented: Binding(
          get: { imports.error != nil }, set: { if !$0 { imports.clearError() } })
      ) {
        Button("OK", role: .cancel) { imports.clearError() }
      } message: {
        Text(imports.error ?? "")
      }
    }

    private func choosePhoto(replacing id: String?) {
      controller.finishEditing()
      photoRequest = imports.begin(replacing: id, at: controller.insertionPoint)
      fileRequest = nil
      choosingPhoto = true
    }
    private func chooseFile(replacing id: String?) {
      controller.finishEditing()
      fileRequest = imports.begin(replacing: id, at: controller.insertionPoint)
      photoRequest = nil
      importingFile = true
    }
  }

  private struct MobileDrawingCrop: View {
    let editor: DrawingEditor
    let id: String
    @Environment(\.dismiss) private var dismiss
    @State private var left = 0.0
    @State private var right = 0.0
    @State private var top = 0.0
    @State private var bottom = 0.0
    @State private var image: CGImage?

    var body: some View {
      NavigationStack {
        Form {
          if let image {
            GeometryReader { proxy in
              let scale = min(
                proxy.size.width / Double(image.width), proxy.size.height / Double(image.height))
              let width = Double(image.width) * scale
              let height = Double(image.height) * scale
              ZStack(alignment: .topLeading) {
                Image(decorative: image, scale: 1).resizable().frame(width: width, height: height)
                Rectangle().stroke(.orange, lineWidth: 3)
                  .frame(width: width * (1 - left - right), height: height * (1 - top - bottom))
                  .offset(x: width * left, y: height * top)
              }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }.frame(height: 220).accessibilityLabel("Crop preview")
          }
          cropSlider("Left", value: $left, maximum: 0.95 - right)
          cropSlider("Right", value: $right, maximum: 0.95 - left)
          cropSlider("Top", value: $top, maximum: 0.95 - bottom)
          cropSlider("Bottom", value: $bottom, maximum: 0.95 - top)
        }
        .navigationTitle("Crop image")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button("Crop") {
              editor.cropImage(
                id, rect: DrawingRect(minX: left, minY: top, maxX: 1 - right, maxY: 1 - bottom))
              dismiss()
            }.disabled(image == nil)
          }
        }
        .task {
          guard let element = editor.element(id), let fileId = element.fileId,
            let url = editor.scene.files.objectValue?[fileId]?.objectValue?["dataURL"]?.stringValue,
            let data = EmbeddedDrawingImages.data(from: url)
          else { return }
          image = EmbeddedDrawingImages.decode(data)
          if let crop = element.extraField("crop")?.objectValue,
            let x = crop["x"]?.numberValue, let y = crop["y"]?.numberValue,
            let width = crop["width"]?.numberValue, let height = crop["height"]?.numberValue,
            let naturalWidth = crop["naturalWidth"]?.numberValue, naturalWidth > 0,
            let naturalHeight = crop["naturalHeight"]?.numberValue, naturalHeight > 0
          {
            left = max(0, min(0.95, x / naturalWidth))
            top = max(0, min(0.95, y / naturalHeight))
            right = max(0, min(0.95 - left, 1 - (x + width) / naturalWidth))
            bottom = max(0, min(0.95 - top, 1 - (y + height) / naturalHeight))
          }
        }
      }
    }
    private func cropSlider(_ title: String, value: Binding<Double>, maximum: Double) -> some View {
      VStack(alignment: .leading) {
        Text("\(title) \(Int(value.wrappedValue * 100))%")
        Slider(value: value, in: 0...max(0, maximum), step: 0.01).accessibilityLabel(title)
      }
    }
  }
#endif
