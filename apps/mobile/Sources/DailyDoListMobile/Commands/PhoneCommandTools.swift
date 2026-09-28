import DailyDoListMobileAgent
import Observation
import SwiftUI
import UIKit

private struct PhoneCommandEnvironmentKey: EnvironmentKey {
  static let defaultValue: PhoneCommandController? = nil
}
extension EnvironmentValues {
  var phoneCommands: PhoneCommandController? {
    get { self[PhoneCommandEnvironmentKey.self] }
    set { self[PhoneCommandEnvironmentKey.self] = newValue }
  }
}

/// Add this to a navigation toolbar. The same catalog supplies touch menus and keyboard shortcuts.
struct PhoneCommandMenu: View {
  @Environment(\.phoneCommands) private var commands
  var body: some View {
    if let commands {
      Menu("Commands and quick open", systemImage: "command") {
        Button("Quick open…") { commands.run(.quickOpen) }
        Button("Command palette…") { commands.run(.palette) }
        Divider()
        ForEach(["Notes", "Navigation", "Editor", "Agent", "Connection", "Recovery"], id: \.self) {
          group in
          Menu(group) {
            ForEach(
              PhoneCommand.all.filter {
                $0.group == group && $0.id != .palette && $0.id != .quickOpen
              }
            ) { command in
              Button(command.title) { commands.run(command.id) }.disabled(
                !commands.canRun(command.id))
            }
          }
        }
      }.accessibilityIdentifier("commands.menu")
    }
  }
}

extension View {
  /// Scope identity resets keyboard/presentation state when the selected connection changes.
  func phoneCommands(
    workspace: PhoneWorkspace, isCurrent: @escaping @MainActor () -> Bool,
    chooseConnection: @escaping @MainActor () -> Void,
    showHostSettings: @escaping @MainActor () -> Void,
    insertDrawing: (@MainActor () -> Void)? = nil,
    visibleThread: @escaping @MainActor () -> String? = { nil }
  ) -> some View {
    PhoneCommandContainer(
      content: self, workspace: workspace, isCurrent: isCurrent,
      chooseConnection: chooseConnection, showHostSettings: showHostSettings,
      insertDrawing: insertDrawing, visibleThread: visibleThread
    )
    .id(workspace.repository.scope)
  }
}

@MainActor private struct PhoneCommandContainer<Content: View>: View {
  let content: Content
  @State private var controller: PhoneCommandController
  @State private var presentationGate: PhoneCommandPresentationGate
  init(
    content: Content, workspace: PhoneWorkspace, isCurrent: @escaping () -> Bool,
    chooseConnection: @escaping () -> Void, showHostSettings: @escaping () -> Void,
    insertDrawing: (() -> Void)?, visibleThread: @escaping () -> String?
  ) {
    self.content = content
    let gate = PhoneCommandPresentationGate()
    let controller = PhoneCommandController(
      workspace: workspace, isCurrent: { isCurrent() && gate.permitsActions },
      chooseConnection: chooseConnection, showHostSettings: showHostSettings,
      insertDrawing: insertDrawing, visibleThread: visibleThread)
    gate.ownedPresentationIsActive = { [weak controller] in
      controller?.presentation != nil || controller?.awaitingDismissal == true
    }
    _presentationGate = State(initialValue: gate)
    _controller = State(initialValue: controller)
  }
  var body: some View {
    content
      .environment(\.phoneCommands, controller)
      .background {
        PhoneCommandPresentationProbe(gate: presentationGate, owned: false)
          .frame(width: 0, height: 0).accessibilityHidden(true)
        // Registered buttons participate in SwiftUI's native hosting-controller key command menu.
        // They never take text focus and are disabled while another presentation owns the input.
        ForEach(PhoneCommand.all.filter { $0.shortcut != nil }) { command in
          if let shortcut = command.shortcut, let character = shortcut.key.first {
            Button(command.title) { controller.run(command.id) }
              .keyboardShortcut(KeyEquivalent(character), modifiers: shortcut.modifiers)
              .disabled(
                controller.presentation != nil || controller.awaitingDismissal
                  || !controller.canRun(command.id)
              )
              .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
          }
        }
      }
      .sheet(item: $controller.presentation, onDismiss: controller.dismissed) {
        presentation in
        Group {
          switch presentation {
          case .palette(let mode): PhonePaletteView(mode: mode, controller: controller)
          case .path(let action, let original, let epoch):
            PhoneCommandPathView(
              controller: controller, action: action, original: original, epoch: epoch)
          case .capture:
            if let workspace = controller.workspace { CaptureTaskView(workspace: workspace) }
          case .history:
            if let workspace = controller.workspace {
              navigation { CaptureHistoryView(workspace: workspace) }
            }
          case .recovery:
            if let workspace = controller.workspace {
              navigation { PhoneRecoveryView(workspace: workspace) }
            }
          case .newRoutine:
            if let store = controller.workspace?.agent {
              MobileNewRoutineView(
                store: store,
                actionsEnabled: controller.canRun(.newRoutine)
              ) { _ in controller.presentation = nil }
            }
          }
        }.background {
          PhoneCommandPresentationProbe(gate: presentationGate, owned: true)
            .frame(width: 0, height: 0).accessibilityHidden(true)
        }
      }
  }
  private func navigation<V: View>(@ViewBuilder _ view: () -> V) -> some View {
    NavigationStack {
      view().toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { controller.presentation = nil }
        }
      }
    }
  }
}

/// SwiftUI sheets can be owned by descendants (Backlinks, previews, Files), so root presentation
/// state alone cannot protect the responder chain. Inspect the live UIKit hierarchy on every
/// action, including actions invoked through the environment rather than a keyboard shortcut.
@MainActor @Observable final class PhoneCommandPresentationGate {
  @ObservationIgnored weak var rootProbe: UIViewController?
  @ObservationIgnored weak var ownedProbe: UIViewController?
  @ObservationIgnored private weak var hostingWindow: UIWindow?
  @ObservationIgnored var ownedPresentationIsActive: () -> Bool = { false }
  private var hierarchyRevision: UInt64 = 0

  func hierarchyChanged() { hierarchyRevision &+= 1 }

  var permitsActions: Bool {
    _ = hierarchyRevision
    guard let rootProbe, rootProbe.parent != nil else { return false }
    if let window = rootProbe.viewIfLoaded?.window { hostingWindow = window }
    // A full-screen sheet temporarily removes its presenter's view from the window. Retain only
    // a weak window reference so owned sheet actions still work, but a retired probe fails closed.
    guard let root = hostingWindow?.rootViewController else { return false }
    var visited: Set<ObjectIdentifier> = []
    var presentedIDs: Set<ObjectIdentifier> = []
    var presented: [UIViewController] = []
    func walk(_ controller: UIViewController) {
      guard visited.insert(ObjectIdentifier(controller)).inserted else { return }
      if let modal = controller.presentedViewController {
        if presentedIDs.insert(ObjectIdentifier(modal)).inserted { presented.append(modal) }
        walk(modal)
      }
      for child in controller.children { walk(child) }
    }
    walk(root)
    guard !presented.isEmpty else { return true }
    guard presented.count == 1, ownedPresentationIsActive(), let ownedProbe else { return false }
    var ancestor: UIViewController? = ownedProbe
    while let current = ancestor {
      if current === presented[0] { return true }
      ancestor = current.parent
    }
    return false
  }
}

private struct PhoneCommandPresentationProbe: UIViewControllerRepresentable {
  let gate: PhoneCommandPresentationGate
  let owned: Bool
  func makeUIViewController(context: Context) -> UIViewController {
    let controller = PhoneCommandProbeController()
    controller.hierarchyChanged = { [weak gate] in
      Task { @MainActor in gate?.hierarchyChanged() }
    }
    controller.view = UIView()
    controller.view.isUserInteractionEnabled = false
    if owned { gate.ownedProbe = controller } else { gate.rootProbe = controller }
    return controller
  }
  func updateUIViewController(_ controller: UIViewController, context: Context) {}
}

private final class PhoneCommandProbeController: UIViewController {
  var hierarchyChanged: (() -> Void)?
  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    hierarchyChanged?()
  }
  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    hierarchyChanged?()
  }
  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    hierarchyChanged?()
  }
}

private struct PhoneCommandPathView: View {
  let controller: PhoneCommandController
  let action: PhoneCommandController.PathAction
  let original: String
  let epoch: UInt64
  @State private var path: String
  init(
    controller: PhoneCommandController, action: PhoneCommandController.PathAction, original: String,
    epoch: UInt64
  ) {
    self.controller = controller
    self.action = action
    self.original = original
    self.epoch = epoch
    _path = State(initialValue: original)
  }
  var body: some View {
    NavigationStack {
      Form {
        if action == .trash {
          Text(original).textSelection(.enabled)
          Text("The host moves this file into the vault's Trash folder.")
        } else {
          TextField("Folder/Name", text: $path).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("commands.path")
          Text("Use a relative path inside this workspace.").font(.footnote).foregroundStyle(
            .secondary)
        }
        if controller.workspace?.generation != epoch {
          Text("The connection changed. Close this form and review the command again.")
            .foregroundStyle(.orange)
        }
      }
      .navigationTitle(title)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { controller.presentation = nil }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(
            action == .trash ? "Move to Trash" : "Save", role: action == .trash ? .destructive : nil
          ) {
            controller.completePath(action, original: original, path: path, epoch: epoch)
          }.disabled(
            path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !controller.isCurrent()
              || controller.workspace?.generation != epoch
              || controller.workspace?.structuralBusy != false
              || ((action == .folder || action == .rename || action == .trash)
                && controller.workspace?.online != true)
          )
          .accessibilityIdentifier("commands.path.save")
        }
      }
    }
  }
  private var title: String {
    switch action {
    case .note: "New note"
    case .folder: "New folder"
    case .drawing: "New drawing"
    case .rename: "Move or rename"
    case .trash: "Move to Trash?"
    }
  }
}
