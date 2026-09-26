import CoreGraphics
import DailyDoListDrawing
import DailyDoListDrawingModel
import Foundation

/// Synthetic scenes for renders and interaction tests.
enum TestScenes {
  static func element(
    _ type: ElementType, id: String, x: Double, y: Double, width: Double = 120, height: Double = 80,
    seed: Int = 1, configure: (inout ExcalidrawElement) -> Void = { _ in }
  ) -> ExcalidrawElement {
    var element = ExcalidrawElement(id: id, type: type)
    element.x = x
    element.y = y
    element.width = width
    element.height = height
    element.seed = seed
    configure(&element)
    return element
  }

  static func text(
    _ text: String, id: String, x: Double, y: Double, fontSize: Double = 20,
    fontFamily: Int = FontFamily.excalifont, container: String? = nil, align: TextAlign = .left,
    verticalAlign: VerticalAlign = .top
  ) -> ExcalidrawElement {
    var element = ExcalidrawElement(id: id, type: .text)
    element.x = x
    element.y = y
    element.text = TextProperties(
      text: text, fontSize: fontSize, fontFamily: fontFamily, textAlign: align,
      verticalAlign: verticalAlign, containerId: container)
    let size = TextLayout.measure(
      text, fontSize: fontSize, fontFamily: fontFamily, lineHeight: element.text!.lineHeight)
    element.width = size.width
    element.height = size.height
    return element
  }

  static func linear(
    _ type: ElementType, id: String, x: Double, y: Double, points: [DrawingPoint], seed: Int = 1,
    configure: (inout ExcalidrawElement) -> Void = { _ in }
  ) -> ExcalidrawElement {
    var element = ExcalidrawElement(id: id, type: type)
    element.x = x
    element.y = y
    element.points = points
    let size = ElementGeometry.sizeFromPoints(points)
    element.width = size.width
    element.height = size.height
    element.seed = seed
    if type == .arrow { element.endArrowhead = .arrow }
    configure(&element)
    return element
  }

  /// Every element type, fill style, stroke style and width, with a label, an arrow between two
  /// shapes, a freehand stroke, text in each family, an image and a frame.
  static func gallery() -> ExcalidrawScene {
    var elements: [ExcalidrawElement] = []
    elements.append(
      element(.rectangle, id: "r1", x: 20, y: 20, width: 160, height: 90, seed: 11) {
        $0.backgroundColor = "#a5d8ff"
        $0.fillStyle = .hachure
        $0.roundness = .adaptive
        $0.boundElements = [BoundElement(id: "label1", type: "text")]
      })
    var label = text(
      "Plan", id: "label1", x: 0, y: 0, container: "r1", align: .center, verticalAlign: .middle)
    label.x = 20 + 80 - label.width / 2
    label.y = 20 + 45 - label.height / 2
    elements.append(label)
    elements.append(
      element(.ellipse, id: "e1", x: 240, y: 20, width: 150, height: 100, seed: 22) {
        $0.backgroundColor = "#ffc9c9"
        $0.fillStyle = .crossHatch
        $0.strokeColor = "#e03131"
      })
    elements.append(
      element(.diamond, id: "d1", x: 440, y: 20, width: 140, height: 110, seed: 33) {
        $0.backgroundColor = "#b2f2bb"
        $0.fillStyle = .solid
        $0.strokeColor = "#2f9e44"
        $0.roundness = .proportional
      })
    elements.append(
      linear(.arrow, id: "a1", x: 185, y: 65, points: [.zero, DrawingPoint(50, 5)], seed: 44))
    elements.append(
      linear(
        .line, id: "l1", x: 20, y: 170,
        points: [.zero, DrawingPoint(80, -30), DrawingPoint(160, 10)], seed: 55
      ) {
        $0.strokeStyle = .dashed
        $0.strokeColor = "#1971c2"
      })
    elements.append(
      linear(
        .arrow, id: "a2", x: 220, y: 190,
        points: [.zero, DrawingPoint(70, -40), DrawingPoint(150, 0)], seed: 66
      ) {
        $0.roundness = .proportional
        $0.strokeStyle = .dotted
        $0.startArrowhead = .dot
        $0.endArrowhead = .triangle
        $0.strokeWidth = 4
      })
    elements.append(
      linear(
        .line, id: "l2", x: 420, y: 150,
        points: [.zero, DrawingPoint(120, 0), DrawingPoint(60, 70), DrawingPoint(2, 2)], seed: 77
      ) {
        $0.backgroundColor = "#ffec99"
        $0.fillStyle = .zigzag
        $0.strokeColor = "#f08c00"
      })
    var squiggle: [DrawingPoint] = []
    for i in 0..<40 {
      let t = Double(i) / 39
      squiggle.append(DrawingPoint(t * 150, sin(t * .pi * 3) * 20))
    }
    elements.append(
      linear(.freedraw, id: "f1", x: 20, y: 260, points: squiggle, seed: 88) {
        $0.simulatePressure = true
        $0.lastCommittedPoint = squiggle.last
        $0.strokeColor = "#9c36b5"
      })
    elements.append(text("Hand-drawn Excalifont", id: "t1", x: 220, y: 240))
    elements.append(
      text("Helvetica 16", id: "t2", x: 220, y: 275, fontSize: 16, fontFamily: FontFamily.helvetica)
    )
    elements.append(
      text(
        "Cascadia code()", id: "t3", x: 380, y: 275, fontSize: 16, fontFamily: FontFamily.cascadia))
    elements.append(
      element(.image, id: "i1", x: 20, y: 320, width: 120, height: 80) {
        $0.strokeColor = "transparent"
      })
    elements.append(
      element(.frame, id: "fr1", x: 180, y: 330, width: 200, height: 70) {
        $0.name = "Frame A"
        $0.roughness = 0
      })
    elements.append(
      element(.rectangle, id: "r2", x: 200, y: 345, width: 80, height: 40, seed: 99) {
        $0.frameId = "fr1"
        $0.strokeWidth = 1
        $0.opacity = 50
        $0.backgroundColor = "#1e1e1e"
      })
    elements.append(
      element(.rectangle, id: "r3", x: 420, y: 330, width: 140, height: 60, seed: 111) {
        $0.angle = 0.3
        $0.strokeWidth = 4
        $0.roughness = 2
      })
    return ExcalidrawScene(elements: elements)
  }

  /// A grid of `count` mixed elements (for performance tests).
  static func large(count: Int) -> ExcalidrawScene {
    var elements: [ExcalidrawElement] = []
    elements.reserveCapacity(count)
    let columns = 50
    let fills: [FillStyle] = [.hachure, .solid, .crossHatch]
    for i in 0..<count {
      let x = Double(i % columns) * 140
      let y = Double(i / columns) * 110
      let id = "el\(i)"
      switch i % 6 {
      case 0:
        elements.append(
          element(.rectangle, id: id, x: x, y: y, width: 110, height: 70, seed: i + 1) {
            $0.roundness = .adaptive
            $0.backgroundColor = ExcalidrawPalette.backgroundPicks[1 + i % 4]
            $0.fillStyle = fills[i % 3]
          })
      case 1:
        elements.append(element(.ellipse, id: id, x: x, y: y, width: 110, height: 70, seed: i + 1))
      case 2:
        elements.append(
          element(.diamond, id: id, x: x, y: y, width: 110, height: 80, seed: i + 1) {
            $0.backgroundColor = "#ffec99"
            $0.fillStyle = .hachure
          })
      case 3:
        elements.append(
          linear(
            .arrow, id: id, x: x, y: y + 40, points: [.zero, DrawingPoint(110, 10)], seed: i + 1))
      case 4:
        let points = (0..<24).map { DrawingPoint(Double($0) * 4.5, sin(Double($0) / 3) * 18) }
        elements.append(
          linear(.freedraw, id: id, x: x, y: y + 30, points: points, seed: i + 1) {
            $0.simulatePressure = true
            $0.lastCommittedPoint = points.last
          })
      default:
        elements.append(text("Note \(i)", id: id, x: x, y: y + 20))
      }
    }
    return ExcalidrawScene(elements: elements)
  }
}

/// Bitmap helpers for render checks.
enum Pixels {
  static func color(_ image: CGImage, x: Int, y: Int) -> (r: Int, g: Int, b: Int, a: Int) {
    let context = CGContext(
      data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
      space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.draw(
      image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height)
    )
    let data = context.data!.assumingMemoryBound(to: UInt8.self)
    return (Int(data[0]), Int(data[1]), Int(data[2]), Int(data[3]))
  }
}
