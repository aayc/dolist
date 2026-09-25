import AppKit
import DailyDoListDrawingModel
import Foundation
import Testing

@testable import DailyDoListDrawing

/// Timings on a 2,000-element drawing (rectangles, ellipses, diamonds with fills, arrows,
/// freehand strokes and text) in a 1200 × 800 canvas at 2× pixels. The goal is 60 fps panning and
/// drawing (16.7 ms a frame). Budgets hold in the unoptimized test build, scaled by
/// `PERF_BUDGET_MULTIPLIER` on slow CI runners; the numbers are printed (`PERF …`) and the release
/// numbers are in the package README.
@MainActor
@Suite("Performance", .serialized)
struct PerformanceTests {
  static let multiplier =
    Double(ProcessInfo.processInfo.environment["PERF_BUDGET_MULTIPLIER"] ?? "") ?? 1
  static let scene = TestScenes.large(count: 2000)
  static let size = CGSize(width: 1200, height: 800)

  struct Stats: CustomStringConvertible {
    var samples: [Double]
    var median: Double { percentile(0.5) }
    var p95: Double { percentile(0.95) }
    func percentile(_ p: Double) -> Double {
      let sorted = samples.sorted()
      guard !sorted.isEmpty else { return 0 }
      return sorted[min(sorted.count - 1, Int((Double(sorted.count) * p).rounded(.up)) - 1)]
    }
    var description: String {
      String(format: "p50 %.2f ms, p95 %.2f ms (n=%d)", median, p95, samples.count)
    }
  }

  static func milliseconds(_ body: () -> Void) -> Double {
    let duration = ContinuousClock().measure(body)
    let (seconds, attoseconds) = duration.components
    return Double(seconds) * 1000 + Double(attoseconds) / 1e15
  }

  /// A bitmap context like the view's backing store (2×, y-down points).
  static func context() -> CGContext {
    let context = CGContext(
      data: nil, width: Int(size.width * 2), height: Int(size.height * 2), bitsPerComponent: 8,
      bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
        | CGBitmapInfo.byteOrder32Little.rawValue)!
    context.translateBy(x: 0, y: size.height * 2)
    context.scaleBy(x: 2, y: -2)
    return context
  }

  func draw(_ canvas: DrawingCanvasView, into context: CGContext) {
    let graphics = NSGraphicsContext(cgContext: context, flipped: true)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    canvas.draw(canvas.bounds)
    NSGraphicsContext.restoreGraphicsState()
  }

  func makeCanvas() -> DrawingCanvasView {
    let canvas = DrawingCanvasView(
      scene: Self.scene, mode: .editing, environment: DeterministicDrawingEnvironment(),
      frame: CGRect(origin: .zero, size: Self.size))
    // About 300 elements on screen at once.
    canvas.setViewport(DrawingViewport(zoom: 0.5, origin: DrawingPoint(0, 0)))
    return canvas
  }

  @Test func generatesShapesForTwoThousandElements() {
    var samples: [Double] = []
    for _ in 0..<3 {
      let cache = ElementRenderCache()
      samples.append(
        Self.milliseconds { for element in Self.scene.elements { _ = cache.entry(for: element) } })
    }
    let stats = Stats(samples: samples)
    print("PERF shape generation, 2,000 elements (cold cache): \(stats)")
    #expect(stats.median < 1500 * Self.multiplier)
  }

  @Test func rendersTheStaticLayerOfTwoThousandElements() {
    let canvas = makeCanvas()
    let context = Self.context()
    draw(canvas, into: context)  // warms the shape cache
    var samples: [Double] = []
    for _ in 0..<5 {
      canvas.staticLayer.invalidate()
      samples.append(Self.milliseconds { draw(canvas, into: context) })
    }
    let stats = Stats(samples: samples)
    print("PERF static layer render (visible area + margins, warm shapes): \(stats)")
    #expect(stats.median < 400 * Self.multiplier)
  }

  @Test func pansAtSixtyFramesPerSecond() {
    let canvas = makeCanvas()
    let context = Self.context()
    draw(canvas, into: context)
    var samples: [Double] = []
    var origin = canvas.viewport.origin
    for _ in 0..<120 {
      origin.x += 2
      origin.y += 1
      canvas.setViewport(DrawingViewport(zoom: 0.5, origin: origin))
      samples.append(Self.milliseconds { draw(canvas, into: context) })
    }
    let stats = Stats(samples: samples)
    print(
      "PERF pan frame (2,000 elements, cached layer; re-rendered past the margin): \(stats), layer renders \(canvas.staticLayer.renderCount)"
    )
    #expect(stats.median < 16.7 * Self.multiplier)
    #expect(canvas.staticLayer.renderCount <= 2)
  }

  @Test func drawsAFreehandStrokeAtSixtyFramesPerSecond() {
    let canvas = makeCanvas()
    let context = Self.context()
    canvas.editor.tool = .freedraw
    draw(canvas, into: context)
    let editor = canvas.editor
    var samples: [Double] = []
    editor.pointerDown(at: DrawingPoint(100, 100))
    for i in 1...200 {
      let point = DrawingPoint(100 + Double(i) * 4, 100 + sin(Double(i) / 8) * 60)
      samples.append(
        Self.milliseconds {
          editor.pointerDragged(to: point)
          draw(canvas, into: context)
        })
    }
    editor.pointerUp(at: DrawingPoint(900, 100))
    let stats = Stats(samples: Array(samples.dropFirst(2)))
    print("PERF freehand frame over 2,000 elements (pointer + redraw, 200 points): \(stats)")
    #expect(stats.median < 16.7 * Self.multiplier)
    #expect(stats.p95 < 33 * Self.multiplier)
  }

  @Test func dragsAShapeAtSixtyFramesPerSecond() {
    let canvas = makeCanvas()
    let context = Self.context()
    draw(canvas, into: context)
    let editor = canvas.editor
    // el0 is a filled rectangle at 0,0 (110 × 70).
    var samples: [Double] = []
    editor.pointerDown(at: DrawingPoint(50, 30))
    for i in 1...120 {
      let point = DrawingPoint(50 + Double(i) * 3, 30 + Double(i) * 2)
      samples.append(
        Self.milliseconds {
          editor.pointerDragged(to: point)
          draw(canvas, into: context)
        })
    }
    editor.pointerUp(at: DrawingPoint(410, 270))
    #expect(editor.element("el0")?.x == 360)
    let stats = Stats(samples: Array(samples.dropFirst(2)))
    print("PERF drag frame over 2,000 elements (pointer + redraw): \(stats)")
    #expect(stats.median < 16.7 * Self.multiplier)
  }

  @Test func readsAndWritesATwoThousandElementFile() throws {
    let text = ExcalidrawMarkdown.newFile(for: Self.scene)
    var parse: [Double] = []
    var write: [Double] = []
    for _ in 0..<3 {
      var parsed: ExcalidrawMarkdown?
      parse.append(Self.milliseconds { parsed = ExcalidrawMarkdown.parse(text) })
      write.append(Self.milliseconds { _ = try? parsed?.serialized() })
      #expect(parsed?.scene.elements.count == 2000)
    }
    let parseStats = Stats(samples: parse)
    let writeStats = Stats(samples: write)
    print("PERF parse 2,000-element file (\(text.utf8.count / 1024) KB): \(parseStats)")
    print("PERF serialize 2,000-element file: \(writeStats)")
    #expect(parseStats.median < 1500 * Self.multiplier)
    #expect(writeStats.median < 1500 * Self.multiplier)
  }

  @Test func commitsAChangeToATwoThousandElementDrawing() {
    let editor = DrawingEditor(scene: Self.scene, environment: DeterministicDrawingEnvironment())
    var samples: [Double] = []
    for i in 0..<20 {
      samples.append(
        Self.milliseconds {
          editor.select(["el\(i * 6)"])
          editor.nudgeSelection(dx: 1, dy: 0)
        })
    }
    let stats = Stats(samples: samples)
    print("PERF nudge + commit (undo diff) on 2,000 elements: \(stats)")
    #expect(stats.median < 30 * Self.multiplier)
  }
}
