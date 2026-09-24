import SwiftUI

/// The app's scenes, exposed so the executable stays a one-liner.
public struct DailyDoListScenes: Scene {
  @State private var model = AppModel()

  public init() {}

  public var body: some Scene {
    WindowGroup("Daily Do List") {
      Text("Daily Do List")
        .frame(minWidth: 800, minHeight: 500)
    }
  }
}
