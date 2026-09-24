// swift-tools-version: 6.0
import PackageDescription

// Pure domain logic ported from @ddl/core: dates & daily notes, task parsing/tracking/anchors,
// wikilinks, vault paths, fuzzy matching. Foundation only; verified against vectors generated
// from the TypeScript implementation (Tests/DailyDoListDomainTests/Vectors, see README.md).
let package = Package(
  name: "DailyDoListDomain",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "DailyDoListDomain", targets: ["DailyDoListDomain"])
  ],
  dependencies: [
    .package(path: "../DailyDoListModels")
  ],
  targets: [
    .target(name: "DailyDoListDomain", dependencies: ["DailyDoListModels"]),
    // The vectors are read from the source tree (#filePath), not bundled as resources.
    .testTarget(
      name: "DailyDoListDomainTests", dependencies: ["DailyDoListDomain"], exclude: ["Vectors"]),
  ]
)
