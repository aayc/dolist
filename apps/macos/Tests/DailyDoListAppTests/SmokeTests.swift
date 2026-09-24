import Testing

@testable import DailyDoListApp

@Test @MainActor func appModelBuilds() {
  let model = AppModel()
  #expect(model.settings == .defaults)
}
