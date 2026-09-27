import DailyDoListMobileKit
import SwiftUI

@main
struct DailyDoListApp: App {
  @State private var model = PhoneAppModel()
  var body: some Scene {
    WindowGroup {
      #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--editor-spike") {
          EditorSpikeView()
        } else if ProcessInfo.processInfo.arguments.contains("--drawing-spike") {
          DrawingSpikeView()
        } else {
          PhoneRootView(model: model)
        }
      #else
        PhoneRootView(model: model)
      #endif
    }
  }
}
