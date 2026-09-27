#if canImport(UIKit)
  import Observation
  import SwiftUI
  import UIKit

  /// The document host owns this controller and persists committed scenes through `onChange`.
  /// Remote changes enter through `replaceScene`; saves and conflicts stay with the host.
  @MainActor
  @Observable
  public final class MobileDrawingController {
    public let editor: DrawingEditor
    public var library: MobileDrawingLibrary = .shared
    @ObservationIgnored public var onOpenLink: ((String) -> Void)?
    @ObservationIgnored public var elementLink: ((String) -> String?)?
    public var isEditing = true
    public var viewOnly = false
    public var zenMode = false
    public var commandError: String?
    public var multiSelect = false
    public var constrain = false
    public var fromCenter = false
    @ObservationIgnored public var onInteractionEnd: (() -> Void)?
    public var hasActiveInteraction: Bool { editor.hasActiveInteraction }
    @ObservationIgnored public var onChange: ((ExcalidrawScene) -> Void)?
    @ObservationIgnored weak var canvas: MobileDrawingCanvasView?

    public init(
      scene: ExcalidrawScene, environment: DrawingEnvironment = SystemDrawingEnvironment()
    ) {
      editor = DrawingEditor(scene: scene, environment: environment)
      editor.onChange = { [weak self] scene in self?.onChange?(scene) }
      editor.onInteractionEnd = { [weak self] in
        Task { @MainActor [weak self] in
          guard let self, !self.hasActiveInteraction else { return }
          self.onInteractionEnd?()
        }
      }
    }

    public func replaceScene(_ scene: ExcalidrawScene, keepHistory: Bool = false) {
      if let canvas {
        canvas.setScene(scene, keepHistory: keepHistory)
      } else {
        editor.replaceScene(scene, keepHistory: keepHistory)
      }
    }
    public func finishEditing() {
      if let canvas { canvas.finishEditing() } else { editor.commitInteraction() }
    }
    public func zoomToFit() { canvas?.zoomToFit() }
    public func zoomToSelection() { canvas?.zoomToSelection() }
    public func resetZoom() { if let canvas { canvas.zoom(by: 1 / canvas.viewport.zoom) } }
    public func zoom(by factor: Double) { canvas?.zoom(by: factor) }
    public var scene: ExcalidrawScene { editor.scene }
  }

  public struct MobileDrawingCanvas: UIViewRepresentable {
    public let controller: MobileDrawingController
    public var theme: DrawingTheme
    public var background: DrawingBackground

    public init(
      controller: MobileDrawingController, theme: DrawingTheme = .light,
      background: DrawingBackground = .scene
    ) {
      self.controller = controller
      self.theme = theme
      self.background = background
    }
    public func makeUIView(context: Context) -> MobileDrawingCanvasView {
      let view = MobileDrawingCanvasView(editor: controller.editor, forwardsChanges: false)
      controller.canvas = view
      view.controller = controller
      return view
    }
    public func updateUIView(_ view: MobileDrawingCanvasView, context: Context) {
      view.mode = controller.isEditing && !controller.viewOnly ? .editing : .display
      view.theme = theme
      view.background = background
      var modifiers: PointerModifiers = []
      if controller.multiSelect || controller.constrain { modifiers.insert(.shift) }
      if controller.fromCenter { modifiers.insert(.option) }
      view.pointerModifiers = modifiers
    }
    public static func dismantleUIView(_ view: MobileDrawingCanvasView, coordinator: ()) {
      view.finishEditing()
    }
  }

  /// A complete canvas surface with scrollable touch controls and an inspector sheet.
  public struct MobileDrawingView: View {
    @Bindable public var controller: MobileDrawingController
    @Environment(\.colorScheme) private var colorScheme
    @State private var propertiesShown = false
    @State private var precisionShown = false
    @State private var transferShown = false
    @State private var canvasShown = false

    public init(controller: MobileDrawingController) { self.controller = controller }
    public var body: some View {
      VStack(spacing: 0) {
        if controller.isEditing && !controller.viewOnly && !controller.zenMode { toolbar }
        MobileDrawingCanvas(controller: controller, theme: colorScheme == .dark ? .dark : .light)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        if controller.isEditing && !controller.viewOnly && !controller.zenMode { commands }
        if controller.isEditing && (controller.viewOnly || controller.zenMode) {
          Button(controller.viewOnly ? "Exit view mode" : "Exit zen mode") {
            controller.viewOnly = false
            controller.zenMode = false
          }.padding(8)
        }
      }
      .sheet(isPresented: $canvasShown) {
        NavigationStack {
          MobileDrawingCanvasSettings(controller: controller)
            .toolbar {
              ToolbarItem(placement: .confirmationAction) {
                Button("Done") { canvasShown = false }
              }
            }
        }
      }
      .alert(
        "Drawing command",
        isPresented: Binding(
          get: { controller.commandError != nil }, set: { if !$0 { controller.commandError = nil } }
        )
      ) {
        Button("OK") { controller.commandError = nil }
      } message: {
        Text(controller.commandError ?? "")
      }
      .sheet(isPresented: $transferShown) {
        NavigationStack {
          MobileDrawingTransfer(controller: controller)
            .toolbar {
              ToolbarItem(placement: .confirmationAction) {
                Button("Done") { transferShown = false }
              }
            }
        }
      }
      .sheet(isPresented: $precisionShown) {
        NavigationStack {
          MobileDrawingPrecision(editor: controller.editor)
            .navigationTitle("Frames and precision")
            .toolbar {
              ToolbarItem(placement: .confirmationAction) {
                Button("Done") { precisionShown = false }
              }
            }
        }
      }
      .sheet(isPresented: $propertiesShown) {
        NavigationStack {
          MobileDrawingProperties(editor: controller.editor)
            .navigationTitle("Drawing properties")
            .toolbar {
              ToolbarItem(placement: .confirmationAction) {
                Button("Done") { propertiesShown = false }
              }
            }
        }
      }
    }

    private var toolbar: some View {
      ScrollView(.horizontal) {
        HStack(spacing: 2) {
          ForEach(DrawingTool.toolbarTools, id: \.self) { tool in
            Button {
              controller.editor.tool = tool
            } label: {
              Image(systemName: tool.symbol).frame(width: 44, height: 44)
                .background(
                  controller.editor.tool == tool ? Color.accentColor.opacity(0.15) : .clear,
                  in: RoundedRectangle(cornerRadius: 8))
            }
            .accessibilityLabel(tool.label)
            .accessibilityAddTraits(controller.editor.tool == tool ? .isSelected : [])
          }
        }.padding(.horizontal, 8)
      }
      .scrollIndicators(.hidden)
      .background(.bar)
    }

    private var commands: some View {
      HStack(spacing: 0) {
        command("Undo", symbol: "arrow.uturn.backward", disabled: !controller.editor.canUndo) {
          controller.editor.undo()
        }
        command("Redo", symbol: "arrow.uturn.forward", disabled: !controller.editor.canRedo) {
          controller.editor.redo()
        }
        command("Properties", symbol: "slider.horizontal.3") { propertiesShown = true }
        MobileDrawingImageControls(controller: controller)
        Spacer(minLength: 0)
        Menu {
          Toggle("Select multiple", isOn: $controller.multiSelect)
          Toggle("Constrain proportions and angles", isOn: $controller.constrain)
          Toggle("Draw from center", isOn: $controller.fromCenter)
          Toggle(
            "Keep tool active",
            isOn: Binding(
              get: { controller.editor.isToolLocked }, set: { controller.editor.isToolLocked = $0 })
          )
          Button("Canvas settings and help") { canvasShown = true }
          Button("View mode") { controller.viewOnly = true }
          Button("Zen mode") { controller.zenMode = true }
          Button("Copy, library and links") { transferShown = true }
          Button("Frames, points and snapping") { precisionShown = true }
          Button("Select all") { controller.editor.selectAll() }
          MobileDrawingArrangeMenu(editor: controller.editor)
          Button("Unlock all") { controller.editor.unlockAll() }
          Button("Duplicate") { controller.editor.duplicateSelection() }.disabled(
            controller.editor.selectedIds.isEmpty)
          Button("Edit text or label") { controller.editor.handleKey(.enter) }.disabled(
            controller.editor.selectedIds.count != 1)
          Button("Finish line") { controller.editor.handleKey(.enter) }.disabled(
            controller.editor.multiPointElementId == nil)
          Button("Delete selection", role: .destructive) { controller.editor.deleteSelection() }
            .disabled(controller.editor.selectedIds.isEmpty)
          Divider()
          Button("Zoom in") { controller.zoom(by: 1.25) }
          Button("Zoom out") { controller.zoom(by: 0.8) }
          Button("Fit drawing") { controller.zoomToFit() }
          Button("Fit selection") { controller.zoomToSelection() }.disabled(
            controller.editor.selectedIds.isEmpty)
          Button("Reset zoom") { controller.resetZoom() }
        } label: {
          Image(systemName: "ellipsis.circle").frame(width: 44, height: 44)
        }
        .accessibilityLabel("Drawing actions")
      }
      .padding(.horizontal, 8)
      .background(.bar)
    }

    private func command(
      _ label: String, symbol: String, disabled: Bool = false, action: @escaping () -> Void
    ) -> some View {
      Button(action: action) { Image(systemName: symbol).frame(width: 44, height: 44) }
        .disabled(disabled).accessibilityLabel(label)
    }
  }
#endif
