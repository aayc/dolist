# Phone storage protection

`PhoneProtectionMigration` makes the phone-only preference correspond to real files and Keychain
attributes. It changes attributes in place: no note, attachment or token is copied into weaker
staging storage. `PhoneProtectionState` records the committed mode and a pending target in a
versioned, atomically written and synchronized `storage-protection.json` inside the application
storage root. A failed migration preserves that target for retry or the next launch. Future,
corrupt or unreadable policy data is an error, never an empty/default replacement.

The default is `.afterFirstUnlock`: non-synchronizing, device-only Keychain items and
`completeUntilFirstUserAuthentication` files. `.whileUnlocked` uses the device-only when-unlocked
Keychain class and `complete` file protection. This follows the device's lock state; a device
without a passcode is considered unlocked. Notification previews remain a separate explicit
opt-in. Both modes retain explicit local-device authentication for every App Intent.

## App lifecycle hooks

1. Keep the same root and existing `KeychainConnectionCredentials` used by pairing and connection
   management. Construct `PhoneProtectionMigration(rootDirectory:credentials:initialMode:)` before
   opening profile/workspace stores. `initialMode` is used only when no policy file exists; it can
   adopt an older phone preference requesting stricter protection. Persisted policy wins thereafter.
   Initialization registers a blocked storage root before reading the policy, so a load failure
   cannot reopen that root under a silent default.
2. Own one `PhoneStorageProtectionController(migration:quiesce:resume:)`. `quiesce` must checkpoint
   every open note/drawing and composer, stop connection and download work, cancel notification
   refresh, call `await backgroundRefresh.cancelAndWait()`, and release **all** workspace/session,
   repository, cache and recovery objects holding SQLite handles. Keep connection profiles and the
   existing Keychain owner. Never forget a profile or delete/move a namespace to change protection.
   If checkpointing fails, retain the objects and report that error. Do not drop unsaved live state.
3. Await `controller.prepare()` before `connection.loadProfiles`, restoring workspaces or starting
   network work. Pass `prepareStorage: { try await controller.prepare() }` to `PhoneIntegrations` so
   a cold authenticated App Intent follows the same gate. Concurrent preparation shares one task.
   Cold preparation does not call quiesce, since no workspace may open before it; this also avoids
   waiting on a background task that requested its own preparation. Live changes and retries do
   quiesce. New callers during that drain receive a busy error rather than awaiting the migration.
   Initial preparation and interrupted migrations finish before storage opens; ordinary completed
   launches update the credential owner's future-write policy without walking all cached files.
4. `resume` recreates and rehydrates the selected workspace and reconnects only after a successful
   runtime preference change or retry. The controller exposes `ready`, `busy`, `state` and `error`.
   Disable workspace actions during a protection change. A busy migration error means some old
   SQLite handle remains retained; release it, then retry. The migration will not mutate an open DB.
5. Show `PhoneStorageProtectionSection(controller:)` in the phone's privacy settings. It displays
   committed/pending state, retry, and confirmation before returning to the default.
   Derive notification preferences' `requiresUnlockedStorage` from
   `!controller.permitsBackgroundRefresh` in the service's live preferences closure, including
   startup and transitions. Do not treat the old saved boolean as evidence of file protection; it
   only chooses `initialMode` when no policy file exists yet.
6. `PhoneStorageProtectionController` observes protected-data availability. Existing SQLite handles
   and checkpoint/profile access fail closed while strict storage is unavailable. The application
   must still checkpoint before suspension and keep its existing app-switcher privacy shield.
   A protected-data error must never be handled as a missing profile, empty note or revoked token.

## How the app composes it

`PhoneAppModel` constructs the migration in its initializer, so the root is registered before
anything can open a store, and owns the only controller (`model.protection`; nil only when the
policy cannot be read, which leaves storage closed). `start()` awaits `prepareStorage()` and only
then loads profiles and restores the saved workspace. `makeIntegrations` passes the same
`prepareStorage` to App Intents and derives background permission from the controller.

`quiesceStorage` first checkpoints every open workspace (`prepareRecoveryExport`: sessions,
drawings, composer drafts). If anything live cannot be saved it refuses before touching the
connection or any workspace. Otherwise it revokes authority, stops the connection, and awaits the
workspaces' download, synchronization and navigation-save tasks, the notification catch-up and
receipts, and `backgroundRefresh.cancelAndWait()`. It then checks the checkpoints again and drops
every workspace (repositories, caches, agent stores and offline channels). The root view hides
workspace views while the controller is busy and keys them on the workspace's identity, so no
view or pushed settings page keeps one alive. Finally it waits boundedly for SwiftUI to release
removed views and requires `migration.storage.openAccessCount == 0`, else it reports `busy` and
the root shows the retry state. It never closes a database or discards anything to get there.
While storage is suspended, `workspace(for:)` refuses to create workspaces and a late connection
verification cannot re-grant authority. `resumeStorage` finishes an interrupted startup, or
reselects the saved profile, which recreates and rehydrates its workspace and reconnects.

Anything new that holds a repository, cache or SQLite handle beyond one call must be reachable
from the workspace (and released with it), or quiesce must await it. A task that outlives the
drain turns every protection change into a retry.

## Protected files owned by other features

A file under the managed root that no repository owns (for example the drawing shape library)
uses `MobileProtectedFile(url:)`: `read()` returns nil only for a missing file, and `write(_:)`
replaces it atomically and durably. Both hold a storage lease, so they fail closed while strict
storage is locked or a migration runs, and new bytes get the committed policy's class; the
migration walk updates existing ones. Use a path under the app storage root (the directory that
holds `storage-protection.json`); outside it the helper applies no protection. Code inside
`DailyDoListMobileKit` can use the package-level `MobileStorageProtection.access(at:)` and
`MobileStorageProtectionMode.writingOptions` directly.

Staged recovery exports are the exception: they stay outside the managed root with `complete`
protection whatever the policy (the migration walk would otherwise downgrade them to the
default class). Run their startup cleanup after `prepareStorage()` succeeds.

## Covered bytes and future writes

`MobileStorageProtection` registers the app storage root and tracks short file leases plus every
SQLite handle's lifetime. Migration blocks new access after those leases drain. Checkpoints,
connection metadata and coordination lockfiles use the selected class for later writes; opening
SQLite uses the iOS SDK's file-protection open flags and applies DB/WAL/SHM file attributes.
A strict-mode reader checks the availability gate before an existing SQLite handle is used.

Downloaded attachments, artifacts, threads, pending attachment originals, captures, composer
text and recovery metadata live in that SQLite database. Markdown, drawing and merge-base files
live in checkpoint folders. All are included in the managed-root attribute walk. Symbolic links
and unexpected file types abort migration rather than following them outside the container.
Recovery exports staged in the app's temporary directory always use complete protection, including
binary originals. Once the user copies an export into Files or another app, that provider owns its
protection. Image/PDF preview pixels and source buffers remain in process memory; this mechanism
is disk/Keychain protection, not memory erasure.

## Verification and device limits

The pure tests cover active-handle refusal, locked reads through existing stores, unchanged bytes,
symlink rejection, each migration failure boundary, restart completion, future/corrupt policy and
locked foreground intents, including a lock during a remote response. A native signed-Simulator
test checks existing/new Keychain items' accessibility and non-synchronization, mode reversal and
token/source preservation. On a physical device that same test also asserts existing/new
checkpoint and SQLite/WAL/SHM file classes. The Simulator omits `NSFileProtectionKey`, so those
attribute assertions are explicitly compiled for device only. These tests use only synthetic
temporary containers and a unique test-only Keychain service. The app's
`PhoneStorageProtectionTests` drive the composed model: startup gated on preparation, refusal on
unsaved live text, a successful change that recreates and reconnects the workspace, a retained
handle's retry state, and a cold intent preparing storage.

A Simulator Keychain check does not establish physical lock encryption. A passcode-protected
physical iPhone is still required to verify first boot before unlock, locking with open handles,
background launch after first unlock, strict-mode denial, Siri authentication, same-device restore,
new-device restore and reinstall behavior. Device-only credentials do not migrate to a different
device; preserved offline notes must remain attached to their original saved workspace identity
while the person pairs again. Free-account signing and periodic reprovisioning remain separate
physical-device checks.

Apple references: [file protection classes](https://developer.apple.com/documentation/foundation/fileprotectiontype),
[Keychain accessibility](https://developer.apple.com/documentation/security/restricting-keychain-item-accessibility),
[protected data availability](https://developer.apple.com/documentation/uikit/uiapplication/isprotecteddataavailable),
[intent authentication](https://developer.apple.com/documentation/appintents/intentauthenticationpolicy/requireslocaldeviceauthentication).
