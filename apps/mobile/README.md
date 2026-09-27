# apps/mobile — native iPhone app

Implementation is in progress. The [plan](PLAN.md) defines the complete scope; the
[implementation ledger](IMPLEMENTATION.md) records what is actually built and verified.
The phone is a native SwiftUI/UIKit client of an existing daemon. It never starts Node or
operates the host directly. A free Apple account is the baseline.

## Build and test

Use full Xcode (currently verified with Xcode 16.4, Swift 6.1.2 and iOS 18.5 Simulator), not only
Command Line Tools. Scripts select Xcode per command using `DEVELOPER_DIR`; override it for
another installation. Deployment targets iOS 17. The project is generated from `project.yml`.

```sh
apps/mobile/scripts/install-xcodegen.sh  # pinned 2.46.0, checked SHA-256
apps/mobile/scripts/build.sh            # unsigned simulator build
apps/mobile/scripts/test.sh             # core, UIKit and real-input UI tests
apps/mobile/scripts/run-simulator.sh --editor-spike  # synthetic input lab, Debug only
```

`DDL_IOS_DESTINATION` selects an Xcode destination for build/test. `DDL_IOS_SIMULATOR_ID` selects
a device for the launch script. Otherwise scripts choose an installed iPhone. Open Simulator to
see it. Generated projects, derived data and local signing settings are ignored. CI runs the
`iPhone app` workflow; it also builds for a physical iPhone SDK without signing. That compilation
is not evidence of physical-device behavior.

For Personal Team installation, generate the project, open it in Xcode and select your team and
a unique bundle identifier. Save reusable overrides in `Resources/Signing.local.xcconfig` (never
commit it): `DEVELOPMENT_TEAM` and `PRODUCT_BUNDLE_IDENTIFIER`. Select the attached iPhone and Run.
Device trust, Developer Mode, signing and periodic reprovisioning require the actual device and
account. The free build has no APNs/Associated Domains/App Group entitlements or paid distribution.

## Architecture

- `DailyDoListMobileKit`: Foundation connection/persistence/services, with fakeable boundaries.
- App sources: phone navigation, SwiftUI screens and platform integration.
- `DailyDoListEditorCore` in the existing editor package: shared markdown tokenizer, incremental
  parser, commands, anchor rules and configuration. Its internals use Swift package access so
  both native adapters share them without exposing implementation details to app shells.
- `DailyDoListMobileEditor`: UIKit input/layout adapter. Mac uses the same extracted parser and
  retains its existing AppKit adapter/tests. Public editor values remain re-exported by the Mac
  editor module for source compatibility.
- Models, Client, Domain, Vim and DrawingModel remain the existing shared Swift products.

Use synthetic content for simulator/computer-use tests. Never connect test code to a real vault
or launch/stop the installed Mac app's daemon. See [AGENTS.md](../../AGENTS.md) and the execution
ledger for the remaining release gates.
