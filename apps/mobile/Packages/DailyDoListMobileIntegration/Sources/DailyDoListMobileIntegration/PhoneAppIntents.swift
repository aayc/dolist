#if os(iOS)
  import AppIntents
  import Foundation

  /// Include this package in an AppIntentsPackage declaration in the application target.
  public struct DoListIntentsPackage: AppIntentsPackage {}

  @MainActor public final class PhoneIntentRuntime {
    public static let shared = PhoneIntentRuntime()
    private var integrations: PhoneIntegrations?
    private var openRoute: (@Sendable (PhoneRoute) async -> Void)?
    public func install(
      _ integrations: PhoneIntegrations, openRoute: @escaping @Sendable (PhoneRoute) async -> Void
    ) {
      self.integrations = integrations
      self.openRoute = openRoute
    }
    func navigate(_ destination: PhoneRoute.Destination) async throws {
      let route = try await requireIntegrations().route(destination)
      guard let openRoute else { throw PhoneIntegrationError.notConfigured }
      await openRoute(route)
    }
    func requireIntegrations() throws -> PhoneIntegrations {
      guard let integrations else { throw PhoneIntegrationError.notConfigured }
      return integrations
    }
  }

  public struct AddToDoListIntent: AppIntent {
    public static let title: LocalizedStringResource = "Add to Do List"
    public static let description = IntentDescription(
      "Save a task to the daily note using this iPhone's date. Offline captures wait safely for the selected connection."
    )
    public static let authenticationPolicy: IntentAuthenticationPolicy =
      .requiresLocalDeviceAuthentication
    @Parameter(title: "Task", requestValueDialog: "What would you like to add?") public var text:
      String
    public init() {}
    public init(text: String) { self.text = text }
    public func perform() async throws -> some IntentResult & ProvidesDialog {
      let integrations = try await PhoneIntentRuntime.shared.requireIntegrations()
      let result = try await integrations.capture(PhoneCaptureRequest(text: text))
      return .result(dialog: IntentDialog(stringLiteral: result.spokenStatus))
    }
  }

  public struct OpenDoListTodayIntent: AppIntent {
    public static let title: LocalizedStringResource = "Open Today in Do List"
    public static let authenticationPolicy: IntentAuthenticationPolicy =
      .requiresLocalDeviceAuthentication
    public init() {}
    public static let openAppWhenRun = true
    public func perform() async throws -> some IntentResult {
      try await PhoneIntentRuntime.shared.navigate(.today)
      return .result()
    }
  }

  public struct ShowDoListApprovalsIntent: AppIntent {
    public static let title: LocalizedStringResource = "Show Do List Approvals"
    public static let authenticationPolicy: IntentAuthenticationPolicy =
      .requiresLocalDeviceAuthentication
    public init() {}
    public static let openAppWhenRun = true
    public func perform() async throws -> some IntentResult {
      try await PhoneIntentRuntime.shared.navigate(.inbox)
      return .result()
    }
  }

  public struct CountDoListApprovalsIntent: AppIntent {
    public static let title: LocalizedStringResource = "Count Do List Approvals"
    public static let authenticationPolicy: IntentAuthenticationPolicy =
      .requiresLocalDeviceAuthentication
    public init() {}
    public func perform() async throws -> some IntentResult & ReturnsValue<Int> & ProvidesDialog {
      let integrations = try await PhoneIntentRuntime.shared.requireIntegrations()
      let result = try await integrations.approvalCount()
      return .result(value: result.count, dialog: IntentDialog(stringLiteral: result.spokenStatus))
    }
  }

  public struct DoListAppShortcuts: AppShortcutsProvider {
    public static var appShortcuts: [AppShortcut] {
      AppShortcut(
        intent: AddToDoListIntent(), phrases: ["Add a task to \(.applicationName)"],
        shortTitle: "Add a task", systemImageName: "plus.circle")
      AppShortcut(
        intent: OpenDoListTodayIntent(), phrases: ["Open today in \(.applicationName)"],
        shortTitle: "Open Today", systemImageName: "calendar")
      AppShortcut(
        intent: ShowDoListApprovalsIntent(), phrases: ["Show approvals in \(.applicationName)"],
        shortTitle: "Show approvals", systemImageName: "tray")
      AppShortcut(
        intent: CountDoListApprovalsIntent(), phrases: ["Count approvals in \(.applicationName)"],
        shortTitle: "Count approvals", systemImageName: "number")
    }
  }
#endif
