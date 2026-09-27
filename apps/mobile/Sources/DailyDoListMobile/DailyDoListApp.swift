import DailyDoListMobileKit
import SwiftUI

@main
struct DailyDoListApp: App {
  var body: some Scene {
    WindowGroup {
      #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--editor-spike") {
          EditorSpikeView()
        } else {
          ConnectionView()
        }
      #else
        ConnectionView()
      #endif
    }
  }
}
