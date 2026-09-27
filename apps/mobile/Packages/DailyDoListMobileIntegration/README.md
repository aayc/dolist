# Native phone integrations

`DailyDoListMobileIntegration` is an iOS 17 package for App Intents, local alerts, safe
navigation and optional short background refresh. It never hosts agent execution or approves
action requests. No App Group, notification service extension, APNs registration or shared
Keychain group is used.

## App wiring

1. Add the package product to the application target. Declare an application-target
   `AppIntentsPackage` with `includedPackages = [DoListIntentsPackage.self]`; framework intents
   need this explicit inclusion. The package provides `DoListAppShortcuts` with four shortcuts.
2. Construct one `PhoneIntegrations` with the **same** repository root, profile store,
   device-only `ConnectionCredentials`, selected-profile closure and Inbox cache as the app.
   `approvalCacheFactory` supplies a `PhoneApprovalCache` for the requested immutable scope;
   `MobileInboxApprovalCache` adapts `MobileAgentContentCache` without a second approval cache.
   Preferences and the visible thread/routine are injected async closures, so changes take effect
   without reconstructing the service. Keep preferences disabled and previews hidden by default.
3. During application initialization, call the synchronous main-actor
   `PhoneIntentRuntime.shared.install(integrations, openRoute: ...)`. The navigation callback must
   open the supplied scoped destination, including a cold-launch Today/Inbox. Both navigation
   intents request foreground launch. Install before the app handles an intent; a late asynchronous
   setup task can otherwise race the intent's first call.
4. Retain `SystemPhoneNotificationCenter(openRoute:)`. Register the `dolist` URL scheme and pass
   external URLs and notification taps through `integrations.parseRoute` before navigation. Routes
   bind profile, workspace and host IDs to saved metadata, contain no credential/body, and only
   support Today, Inbox and thread review. Opening an approval always refreshes the normal review
   UI; no route or notification action makes a decision.
5. The Settings notification button calls `requestNotificationPermission()`. Persist `enabled`
   only when appropriate for the user's choice, then call `catchUp()`. Call it again after a
   verified reconnect/foreground refresh and after approval decisions to remove obsolete alerts.
   Forward live routine decisions through `receive(_:scope:)`; live and catch-up share IDs.
   On disabling alerts or previews, and before forgetting a connection, call
   `clearNotifications()` to remove already visible content.
   Catch-up itself never prompts for permission. Surface catch-up errors as an update/status issue.
6. If background refresh is desired, retain `PhoneBackgroundRefresh(identifier:integrations:)`,
   call `register()` during launch, list that exact identifier in
   `BGTaskSchedulerPermittedIdentifiers`, and add `fetch` to `UIBackgroundModes`. Call `schedule()`
   after the user opts in and when the app backgrounds. It cancels scheduling when disabled or
   `requiresUnlockedStorage` is selected. That preference must match the app's actual stricter
   Keychain/file protection configuration; this package does not migrate storage protection.

Use the existing application Keychain service and storage directories. Do not create an alternate
App Group container or copy bearer tokens into preferences, routes, notifications or SQLite.
App Intents require local device authentication, including the count-only intent. Cached approvals
are labeled as cached and cannot authorize any decision. An empty cache plus a failed refresh is
an error, not a claim that there are zero approvals.

## Delivery and recovery

`PhoneCaptureRequest` freezes a UUID, text, timestamp and time zone once. Capture persists through
`CaptureOutbox` before network work. A dropped response leaves that exact operation pending;
retries must reuse the request/UUID. The short intent attempts only its own operation; it does
not drain an older backlog while Siri is waiting. A new Siri invocation is a new explicit capture, while normal
foreground outbox synchronization recovers an earlier pending invocation. Spoken responses
separate confirmed addition, waiting for connection and indeterminate status. None claims an agent
has started work merely because capture was accepted.

Routine catch-up requests at most three pages of 100 per pass. The server decides whether a run
should notify; the phone does not infer `when_changed` from status. A nil cursor establishes a
baseline without alerting on historical runs. Cursor and items commit together in the existing
workspace notification row. A pending item is delivered with a deterministic system identifier,
then acknowledged in SQLite. After an acknowledgement loss, existing system IDs close the crash
window; completed IDs also survive dismissal and restart. The cache retains 500 items and 2,000
seen IDs. An extremely old event beyond retained history may be shown again if a server replays it.

Visible thread/routine updates are consumed without an alert. Approval alerts are refreshed from
current pending requests and removed after a decision/expiry. Previews are generic by default;
opt-in bodies are bounded. Privacy changes during an in-flight system delivery remove the obsolete
alert. OS scheduling and the notification permission determine actual presentation.

The integration HTTP adapter uses a five-second request timeout, refuses redirects, and sends
authentication only in headers. Background refresh uses only bounded REST work and cancels on expiration. iOS decides whether
and when it runs; this cannot promise notifications while the app is suspended or terminated.
There is no persistent socket, audio/location workaround, automatic approval or queued control.

## Verification

From the repository root, with Xcode's Swift selected:

```sh
apps/macos/scripts/test.sh ../../mobile/Packages/DailyDoListMobileIntegration
```

The tests use temporary SQLite namespaces and fake remotes/notification centers: lost capture
responses, exact retry/date preservation, notification baseline/deduplication, acknowledgement loss,
private/visible updates, offline counts, stale links, and forgotten-workspace fencing. Build the
package scheme for `generic/platform=iOS` with `CODE_SIGNING_ALLOWED=NO` to check native APIs and
App Intents metadata extraction. Application wiring must also be built and exercised in Simulator.
Real Siri invocation, lock-screen authentication and background launch scheduling require device
verification; a successful SDK build does not establish that those physical-device checks ran.

Apple references: [framework intent discovery](https://developer.apple.com/documentation/appintents/appintentspackage),
[explicit intent authentication](https://developer.apple.com/documentation/appintents/appintent/authenticationpolicy),
[notification consent](https://developer.apple.com/documentation/UserNotifications/asking-permission-to-use-notifications),
[background execution strategies](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app).
