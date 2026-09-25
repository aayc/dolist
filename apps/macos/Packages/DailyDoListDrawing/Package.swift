// swift-tools-version: 6.0
import PackageDescription

// The native drawing engine: Excalidraw scenes in Obsidian's `.excalidraw.md` files, drawn with a
// port of Rough.js and edited in an AppKit canvas. DailyDoListDrawingModel is Foundation only (the
// scene model, its JSON codec, the file format, LZ-String) and also builds for iOS;
// DailyDoListDrawing adds the Rough.js port, the CoreGraphics renderer, the editing tools and the
// canvas view (AppKit only in its View folder). Test fixtures are read from the source tree.
let package = Package(
  name: "DailyDoListDrawing",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .library(name: "DailyDoListDrawingModel", targets: ["DailyDoListDrawingModel"]),
    .library(name: "DailyDoListDrawing", targets: ["DailyDoListDrawing"]),
  ],
  dependencies: [
    .package(path: "../DailyDoListUI")
  ],
  targets: [
    .target(name: "DailyDoListDrawingModel"),
    .target(
      name: "DailyDoListDrawing",
      dependencies: [
        "DailyDoListDrawingModel",
        .product(name: "DailyDoListUI", package: "DailyDoListUI"),
      ]),
    .testTarget(
      name: "DailyDoListDrawingTests",
      dependencies: [
        "DailyDoListDrawingModel", "DailyDoListDrawing",
        .product(name: "DailyDoListUI", package: "DailyDoListUI"),
      ],
      exclude: ["fixtures"]),
  ]
)
