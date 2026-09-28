#if os(iOS)
  import DailyDoListMobileKit
  import SwiftUI

  public struct PhoneStorageProtectionSection: View {
    @Bindable private var controller: PhoneStorageProtectionController
    @State private var confirmingDefault = false
    public init(controller: PhoneStorageProtectionController) { self.controller = controller }
    public var body: some View {
      Section {
        Toggle(
          "Require unlocked iPhone for stored data",
          isOn: Binding(
            get: { (controller.state.pending ?? controller.state.mode) == .whileUnlocked },
            set: { strict in
              if strict {
                Task { await controller.change(to: .whileUnlocked) }
              } else {
                confirmingDefault = true
              }
            })
        )
        .disabled(controller.busy || !controller.ready)
        if controller.busy {
          ProgressView("Updating storage protection")
        } else if controller.state.pending != nil || !controller.ready {
          Text("Storage protection setup is unfinished.").foregroundStyle(.secondary)
          Button("Retry protection setup") { Task { await controller.retry() } }
        }
        if let error = controller.error { Text(error).foregroundStyle(.secondary) }
      } header: {
        Text("Stored data")
      } footer: {
        Text(
          "The default keeps credentials on this device and allows protected cached data after the first unlock following a restart. Requiring unlock also protects notes, attachments, drafts and cached conversations while locked and pauses background refresh. Set a device passcode in iPhone Settings to use lock protection."
        )
      }
      .confirmationDialog(
        "Allow data access after the first unlock?", isPresented: $confirmingDefault,
        titleVisibility: .visible
      ) {
        Button("Use default protection") { Task { await controller.change(to: .afterFirstUnlock) } }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text(
          "After you unlock once following a restart, this app can access its cached data and credentials while the iPhone is locked for optional background refresh."
        )
      }
    }
  }
#endif
