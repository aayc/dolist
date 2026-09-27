import DailyDoListClient
import DailyDoListMobileIntegration
import DailyDoListMobileKit
import Foundation

struct PhoneThreadDestination: Identifiable { let id: String }

extension PhoneAppModel {
  func installPhoneIntegrations(
    profiles: any ConnectionProfileStore, credentials: any ConnectionCredentials, rootDirectory: URL
  ) {
    if let data = UserDefaults.standard.data(forKey: "phoneNotifications"),
      let saved = try? JSONDecoder().decode(PhoneNotificationPreferences.self, from: data)
    {
      notificationPreferences = saved
    }
    let center = SystemPhoneNotificationCenter { [weak self] url in
      await self?.openIntegrationURL(url)
    }
    let workspaceRoot = rootDirectory.appendingPathComponent("workspaces")
    let integrations = PhoneIntegrations(
      rootDirectory: workspaceRoot, profiles: profiles, credentials: credentials,
      selectedProfile: {
        await MainActor.run {
          UserDefaults.standard.string(forKey: "selectedConnection").flatMap(UUID.init(uuidString:))
        }
      },
      preferences: { [weak self] in await self?.notificationPreferences ?? .init() },
      visibleDestination: { [weak self] in
        await MainActor.run {
          guard let self, self.appActive, let workspace = self.workspace,
            workspace.selectedTab == 2 || workspace.selectedTab == 3
          else { return PhoneVisibleDestination() }
          return PhoneVisibleDestination(
            scope: workspace.repository.scope, threadID: self.visibleThreads.sorted().first,
            routineID: self.visibleRoutines.sorted().first)
        }
      }, notificationCenter: center,
      approvalCacheFactory: {
        try MobileInboxApprovalCache(rootDirectory: workspaceRoot, scope: $0)
      })
    self.integrations = integrations
    notificationCenter = center
    PhoneIntentRuntime.shared.install(integrations) { [weak self] route in
      await self?.openIntegrationRoute(route)
    }
    let refresh = PhoneBackgroundRefresh(
      identifier: "app.dailydolist.iphone.refresh", integrations: integrations)
    if refresh.register() { backgroundRefresh = refresh }
  }

  func openIntegrationURL(_ url: URL) async {
    do {
      guard let integrations else { return }
      await openIntegrationRoute(try await integrations.parseRoute(url))
    } catch { self.error = error.localizedDescription }
  }

  func openIntegrationRoute(_ route: PhoneRoute) async {
    await connection.loadProfiles()
    guard let profile = connection.profiles.first(where: { $0.id == route.scope.profileID }),
      profile.workspaceID == route.scope.workspaceID, profile.hostID == route.scope.hostID,
      profile.origin == route.scope.origin
    else {
      error = PhoneIntegrationError.invalidRoute.localizedDescription
      return
    }
    if workspace?.repository.scope != route.scope { await select(profile) }
    guard let workspace, workspace.repository.scope == route.scope else { return }
    switch route.destination {
    case .today: await workspace.openToday()
    case .inbox:
      workspace.selectedTab = 2
      await workspace.agent?.refresh()
    case .thread(let id, _):
      workspace.selectedTab = 2
      await workspace.agent?.refresh()
      workspace.routedThread = PhoneThreadDestination(id: id)
    }
  }

  func scheduleNotificationRefresh() {
    notificationRefreshTask?.cancel()
    guard notificationPreferences.enabled, connection.actionsEnabled else { return }
    notificationRefreshTask = Task { [weak self] in
      do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
      guard let self, !Task.isCancelled else { return }
      await self.refreshNotifications()
    }
  }

  func refreshNotifications() async {
    do {
      try await integrations?.catchUp()
      notificationError = nil
    } catch is CancellationError {
    } catch { notificationError = error.localizedDescription }
  }

  func receiveNotificationEvent(_ item: DaemonStreamItem) {
    guard case .event(let event) = item else { return }
    switch event {
    case .approvalUpsert: scheduleNotificationRefresh()
    case .routineNotification(let value):
      guard let scope = workspace?.repository.scope, let integrations else { return }
      Task {
        do { try await integrations.receive(value, scope: scope) } catch {
          notificationError = error.localizedDescription
        }
      }
    default: break
    }
  }

  func updateNotificationPreferences(_ value: PhoneNotificationPreferences) async {
    let previous = notificationPreferences
    notificationPreferences = value
    do {
      UserDefaults.standard.set(try JSONEncoder().encode(value), forKey: "phoneNotifications")
      if !value.enabled || previous.showPreviews != value.showPreviews {
        try await integrations?.clearNotifications()
      }
      try await backgroundRefresh?.schedule()
      if value.enabled { await refreshNotifications() }
    } catch { notificationError = error.localizedDescription }
  }

  func enableNotifications() async {
    do {
      guard try await integrations?.requestNotificationPermission() == true else {
        notificationError = "Notifications are disabled in iPhone Settings."
        return
      }
      var value = notificationPreferences
      value.enabled = true
      await updateNotificationPreferences(value)
    } catch { notificationError = error.localizedDescription }
  }
}
