# DailyDoListMobileSettings

Native iPhone SwiftUI settings and host management, using the shared daemon client and models.
The app owns connection selection, phone cache/capture preferences and the navigation stack.
This package owns only its forms and request state; it never launches a process or invokes
privileged vault/import/computer-permission routes.

## Integration

Add the local package and link its `DailyDoListMobileSettings` product. Present
`MobileSettingsView` inside an existing `NavigationStack`, for example as the destination of a
Host settings link in the phone settings tab. It accepts:

- `client: (any DaemonClient)?`: the authenticated client for the selected host.
- `settings: AppSettings?`: the last acknowledged snapshot (cached snapshots can be read offline).
- `hostName: String`: the actual connected host's name.
- `actionsEnabled: Bool`: true only while authenticated and online.
- `hostID: String?`: pass a stable host/workspace/session identifier. A different identifier or
  client object resets all child forms, drafts and confirmations. The name is a fallback only.
- `isCurrentSession: @MainActor () -> Bool`: a live guard, required. Capture the expected
  host/workspace/session identity and return true only while it still matches the app's current
  connection and that connection remains online. This also fences requests from an old navigation
  hierarchy while SwiftUI replaces it.
- `onSettingsSaved: (AppSettings) -> Void`: persist the acknowledged settings snapshot in the
  app's workspace/cache and publish it to other views. Called only after a successful save from
  the current live session.

The view has no private NavigationStack. Its child forms all retain the same session store.
Shared changes are explicit Save operations containing only the changed fields. Unknown enum
fallbacks in older clients are never sent back unless the user changes that field. Failed writes
are not queued or replayed. Errors remain inline and another attempt requires a user action.
Request results are discarded after host/client replacement, offline transitions or a false live
guard. No credential or pairing code is persisted by this package.

## Coverage

The shared forms cover every `AppSettings` field: theme; all editor options and vimrc;
daily/weekly folders, formats and templates with local-date previews; all agent switches, harness,
OpenRouter/Cursor/judge models, settle/concurrency/watch/timeout settings; approval policy; and
shared always-on machine name/address/clear. Every policy widening requires explicit confirmation
bound to the old and new policy. Hard-denied actions remain blocked.

Host controls explicitly name the daemon being changed. They cover its device name, placement,
readiness, machine pair/check/forget, sync setup/status/conflicts/disable, remote-host names,
paired devices/code expiry/revocation, connector status and version/agent diagnostics. Environment
locks are read-only. Revoking this iPhone's own credential is left to connection management.

The host setup page describes Obsidian import/update, vault switching, Finder/file-manager access,
model credentials, Cursor CLI login, daemon lifecycle and granting Mac permissions. These remain
host-side actions; no authorization boundary is changed.

## Validation

The tests use synthetic clients and manually released response gates, without sleeps or network:
changed-field patches (including complete machine values), preservation of unknown enum fallbacks,
all approval-policy widening transitions, acknowledgement-only saves, rejection of stale consent,
host replacement and late responses, and the live session guard. Run from the repository root:

```sh
apps/macos/scripts/test.sh ../../mobile/Packages/DailyDoListMobileSettings
```

Use Xcode's Swift toolchain when both Xcode and another Swift installation are present. The package
also builds unsigned with the iOS simulator/device SDK. Integrated computer-use validation is an
app-level step, separate from these store tests and SDK builds.
