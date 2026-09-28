# Drawing import safety — unfinished handoff

This checkpoint preserves work interrupted for an agent transfer. **It has not been compiled or
tested and is not ready to integrate as a completed feature.** No drawing tests or Simulator runs
were started. Its base is `1346a03`; the separate completed phone protection checkpoint is
`22d1f60` on `codex/iphone-protection`.

## Begun changes

- `DrawingEditor+ValidatedImport.swift` stages an import on a disposable editor, validates the
  resulting scene, then publishes one undo step. It rejects an active gesture/text interaction.
- `DrawingImportContext.swift` serializes the candidate with preserved markdown and measures
  `JSONEncoder.daemon.encode(WriteNoteRequest(...))`, including conditional version and escaping,
  against the daemon's 5 MiB request limit. The package now depends on Models for its actual codec.
- `DrawingImageImportSession.swift` binds an asynchronous photo load to a request ID, replacement
  element ID and insertion point. A new request cancels the old task; completion checks identity
  and cancellation because providers can ignore cancellation.
- `MobileDrawingImports.swift` normalizes raster images or preserves accepted SVG bytes, checks
  live editability, and routes image/shape insertion through candidate validation.
- `MobileDrawingImageControls.swift` uses those requests, cancels on disappearance/read-only mode,
  and routes image-file imports through the same controller entry point.
- `MobileDrawingTransfer.swift` applies the import guard to paste/image/style operations and checks
  read-only mode for cut. `MobileDrawingLibrary.swift` now calls `insertShapes` for insertion only.

## Root hook still required

`MobileDrawingController.importContext` currently defaults to a new document. The owning drawing
session must provide its latest preserved source and version; otherwise existing frontmatter and
non-scene sections are missing from the size calculation:

```swift
controller.importContext = { [weak self] in
  DrawingImportContext(
    previous: self?.drawing.document,
    baseVersion: self?.drawing.baseVersion)
}
```

The controller diff adds only this property. Preserve the integrator's newer `focusElement` and
pending-layout methods when combining branches; they are not present in this checkpoint's base.
No app, DrawingSession, canvas, MobileKit or root project files were edited in this WIP.

## Protected library remains entirely unfinished

The existing shared shape library still persists user-derived shapes and embedded images in
`UserDefaults` under `drawing.library.v1`, outside the protected app root. The integrator approved
replacing persistence with injected load/save callbacks and an app-owned adapter using
MobileStorageProtection leases, attributes and durable atomic writes. Keep package dependencies
acyclic: Drawing must not depend on MobileKit, which already depends on DrawingModel.

Required migration behavior: retain original legacy bytes until the exact new protected file has
been durably saved and read back successfully, then clear the legacy key. Any load/write/verification
failure must retain original bytes and expose an error/export path. Inject one protected library
into every controller; the shared default must not silently continue writing private scene content
outside the managed root. Library imports/additions need bounded validation too. No adapter,
library migration, persistence callback API or tests for this have been written.

## Remaining verification and implementation

1. Compile all new code with the repository's Apple Swift 6.1.2 wrapper and unsigned iPhone SDK.
   Confirm PhotosPickerItem's sendability and request lifecycle, including picker dismissal.
2. Add deterministic async tests: a late first provider cannot replace a second target; cancellation
   ignores late success/error; read-only state at completion refuses the import.
3. Test candidate rejection leaves scene/files/selection/history and save callback counts unchanged;
   accepted imports produce one undo step and preserve unknown fields/tombstones.
4. Test exact request-size boundaries including preserved markdown, base version, JSON escaping,
   Unicode, existing retained files and normalized image expansion. Cover photo/file/paste/library
   insertion paths. The 32 MiB decoder limit is intentionally unchanged for existing drawing display.
5. Implement protected library persistence and legacy migration with failure-injection tests, then
   document the root adapter/controller injection alongside the import context hook.
6. Audit stale file-picker callbacks and active text/gesture behavior. Current image begin calls
   `finishEditing`; ongoing interactions at later commit are refused rather than discarded.
7. Coordinate any native tests with the integrator before starting a Simulator. The integrator
   owns CUA and the shared Simulator window. No device or Simulator tests were running at handoff.

The completed protection checkpoint separately passed MobileKit 123 tests, MobileIntegration 18
tests, 22 native test cases (25 parameterized executions), full lint, and unsigned iPhone build plus
build-for-testing. Simulator omits file-protection attributes; file-class assertions are explicitly
physical-device-only, and actual passcode/lock/Siri/restore checks remain physical-device work.
