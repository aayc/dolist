// swift-tools-version: 6.0
import PackageDescription

// `ddl-computer`, the helper the daemon spawns to operate one app at a time through its
// accessibility tree: read the tree with element ids, press, set values, type and press keys at a
// process, capture one app's window. macOS only (AppKit, ApplicationServices, CoreGraphics,
// ScreenCaptureKit). The DailyDoListComputer library holds the logic, with everything that touches
// the OS behind protocols; the executable wires the live system to stdin and stdout.
let package = Package(
  name: "DailyDoListComputer",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "DailyDoListComputer", targets: ["DailyDoListComputer"]),
    .executable(name: "ddl-computer", targets: ["ddl-computer"]),
  ],
  targets: [
    .target(name: "DailyDoListComputer"),
    .executableTarget(name: "ddl-computer", dependencies: ["DailyDoListComputer"]),
    .testTarget(name: "DailyDoListComputerTests", dependencies: ["DailyDoListComputer"]),
  ]
)
