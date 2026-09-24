// swift-tools-version: 6.0
import PackageDescription

// Pure domain logic ported from @ddl/core: dates & daily notes, task parsing/tracking/anchors,
// wikilinks, vault paths, fuzzy matching. Foundation only; verified against vectors generated
// from the TypeScript implementation.
let package = Package(
  name: "DailyDoListDomain",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "DailyDoListDomain", targets: ["DailyDoListDomain"]),
  ],
  dependencies: [
    .package(path: "../DailyDoListModels"),
  ],
  targets: [
    .target(name: "DailyDoListDomain", dependencies: ["DailyDoListModels"]),
    .testTarget(name: "DailyDoListDomainTests", dependencies: ["DailyDoListDomain"]),
  ]
)
