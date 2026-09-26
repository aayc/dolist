import AppKit
import DailyDoListUI
import SwiftUI

/// Semantic color of a status, risk or result (same palette as the web app's `--ddl-*` tokens).
public enum Tone: String, CaseIterable, Hashable, Sendable {
  case accent, faint, info, warning, success, danger

  public var color: Color {
    switch self {
    case .accent: Theme.accent
    case .faint: Theme.faintText
    case .info: Theme.info
    case .warning: Theme.warning
    case .success: Theme.success
    case .danger: Theme.danger
    }
  }

  /// The tone for AppKit and Core Animation.
  var nsColor: NSColor { NSColor(color) }

  /// Text and icons drawn on a fill of this tone: the dark palette's status tones are too light
  /// for white.
  public var onFillColor: Color {
    switch self {
    case .accent, .faint: .white
    case .info, .warning, .success, .danger: Theme.background
    }
  }
}
