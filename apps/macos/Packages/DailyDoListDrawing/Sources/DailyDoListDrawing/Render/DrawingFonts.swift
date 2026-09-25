import CoreText
import Foundation

/// The fonts text elements draw with. Excalifont, Excalidraw's hand-drawn font (OFL-1.1), is
/// bundled; the other families map to fonts every Mac has.
public enum DrawingFonts {
  /// The resource bundle SwiftPM builds for this target, found without `Bundle.module` (which
  /// looks next to the `.app` and traps when it isn't there).
  static let resourceBundleName = "DailyDoListDrawing_DailyDoListDrawing.bundle"

  /// Excalifont, loaded from the bundled file once; nil when the file can't be found or read.
  /// Font descriptors are immutable.
  nonisolated(unsafe) static let excalifont: CTFontDescriptor? = {
    guard let url = resourceURL("Excalifont-Regular.woff2"),
      let data = try? Data(contentsOf: url) as CFData,
      let descriptor = CTFontManagerCreateFontDescriptorFromData(data)
    else { return nil }
    return descriptor
  }()

  /// Whether the bundled Excalifont loaded.
  public static var hasExcalifont: Bool { excalifont != nil }

  static func resourceURL(_ name: String) -> URL? {
    var roots: [URL] = []
    if let resources = Bundle.main.resourceURL { roots.append(resources) }
    roots.append(Bundle.main.bundleURL)
    roots.append(Bundle.main.bundleURL.deletingLastPathComponent())
    for bundle in Bundle.allBundles + Bundle.allFrameworks {
      roots.append(bundle.bundleURL.deletingLastPathComponent())
    }
    if let executable = Bundle.main.executableURL {
      roots.append(executable.deletingLastPathComponent())
    }
    let manager = FileManager.default
    for root in roots {
      let bundle = root.appendingPathComponent(resourceBundleName)
      for path in ["Fonts/\(name)", "Contents/Resources/Fonts/\(name)"] {
        let url = bundle.appendingPathComponent(path)
        if manager.fileExists(atPath: url.path) { return url }
      }
    }
    return nil
  }

  private static let lock = NSLock()
  nonisolated(unsafe) private static var fonts: [FontKey: CTFont] = [:]

  private struct FontKey: Hashable {
    var family: Int
    var size: Double
  }

  /// The font for an Excalidraw family id at a size.
  public static func font(family: Int, size: Double) -> CTFont {
    let key = FontKey(family: family, size: size)
    if let font = lock.withLock({ fonts[key] }) { return font }
    let font = makeFont(family: family, size: size)
    lock.withLock { fonts[key] = font }
    return font
  }

  /// The PostScript name each family maps to on the Mac (Excalifont for the hand-drawn ones).
  public static func systemFontName(for family: Int) -> String? {
    switch family {
    case FontFamily.helvetica: "Helvetica"
    case FontFamily.cascadia, FontFamily.comicShanns: "Menlo-Regular"
    case FontFamily.nunito: "AvenirNext-Regular"
    case FontFamily.lilitaOne: "ArialRoundedMTBold"
    case FontFamily.liberationSans: "ArialMT"
    default: nil
    }
  }

  private static func makeFont(family: Int, size: Double) -> CTFont {
    if let name = systemFontName(for: family) {
      return CTFontCreateWithName(name as CFString, size, nil)
    }
    if let excalifont {
      return CTFontCreateWithFontDescriptor(excalifont, size, nil)
    }
    // Without the bundled font, a hand-drawn-looking system font.
    return CTFontCreateWithName("ChalkboardSE-Regular" as CFString, size, nil)
  }
}
