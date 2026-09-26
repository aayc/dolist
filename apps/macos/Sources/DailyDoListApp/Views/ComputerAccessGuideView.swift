import AppKit
import DailyDoListUI
import SwiftUI

/// The guide panel's card beside System Settings: which switch to turn on, the app's icon to drag
/// into the list when Daily Do List isn't in it, and a check the moment the permission comes
/// through. Its buttons are drawn by the app (not AppKit), so they look the same while System
/// Settings has the focus.
struct ComputerAccessGuideView: View {
  let access: ComputerAccessSetup
  /// The guide as last shown, so the card stays while the panel fades out.
  @State private var lastGuide: ComputerAccessGuide?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: 0) {
      if let guide = access.guide ?? lastGuide {
        card(guide)
      }
    }
    .padding(ComputerAccessGuideLayout.margin)
    .frame(
      width: ComputerAccessGuideLayout.panelSize.width,
      height: ComputerAccessGuideLayout.panelSize.height, alignment: .top
    )
    .foregroundStyle(Theme.text)
    .onChange(of: access.guide, initial: true) { old, new in
      guard let new else { return }
      lastGuide = new
      if let announcement = Self.announcement(from: old, to: new) {
        AccessibilityNotification.Announcement(announcement).post()
      }
    }
  }

  /// What VoiceOver says when the guide moves on.
  static func announcement(from old: ComputerAccessGuide?, to new: ComputerAccessGuide) -> String? {
    guard old?.phase != new.phase || old?.permission != new.permission else { return nil }
    switch new.phase {
    case .waiting: return nil
    case .granted: return "\(new.permission.title) is on"
    case .allSet: return "All set. Agents can use your apps now."
    }
  }

  private func card(_ guide: ComputerAccessGuide) -> some View {
    ZStack(alignment: .topLeading) {
      switch guide.phase {
      case .waiting:
        GuideWaiting(access: access, guide: guide)
          .transition(phaseTransition)
      case .granted:
        GuideGranted(access: access, permission: guide.permission)
          .transition(phaseTransition)
      case .allSet:
        GuideAllSet()
          .transition(phaseTransition)
      }
    }
    .padding(18)
    .frame(width: ComputerAccessGuideLayout.cardWidth, alignment: .leading)
    .background(
      Theme.elevated,
      in: RoundedRectangle(cornerRadius: ComputerAccessGuideLayout.cornerRadius, style: .continuous)
    )
    .overlay(
      RoundedRectangle(cornerRadius: ComputerAccessGuideLayout.cornerRadius, style: .continuous)
        .strokeBorder(Theme.separator)
    )
    .shadow(color: .black.opacity(0.24), radius: 16, y: 6)
    .animation(motion, value: guide)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Set up computer use")
  }

  private var phaseTransition: AnyTransition {
    reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.97, anchor: .top))
  }

  private var motion: Animation {
    reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.38, dampingFraction: 0.78)
  }
}

/// Switch Daily Do List on in the list (then relaunch, for Screen Recording).
private struct GuideWaiting: View {
  let access: ComputerAccessSetup
  let guide: ComputerAccessGuide

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 6) {
        GuideCaption(permission: guide.permission, stepLabel: guide.stepLabel)
        Text(title)
          .font(.system(size: 15))
          .fixedSize(horizontal: false, vertical: true)
        Text("Find it in the list and switch it on.")
          .font(.system(size: 12))
          .foregroundStyle(Theme.mutedText)
      }
      AppIconDragWell(icon: access.system.appIcon(), bundleURL: access.system.appBundleURL)
      if guide.permission.appliesWithoutRelaunch {
        Text("Already on but still waiting? Remove it with −, then drag the icon back in.")
          .font(.system(size: 11))
          .foregroundStyle(Theme.faintText)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        GuideNote(
          systemImage: "arrow.clockwise",
          text: access.relaunchUnavailableReason
            ?? "macOS then asks to quit and reopen Daily Do List: choose Quit & Reopen there, or Relaunch Now here."
        )
      }
      footer
    }
  }

  /// "Turn on **Daily Do List** under Accessibility".
  private var title: AttributedString {
    var app = AttributedString("Daily Do List")
    app.font = .system(size: 15, weight: .semibold)
    return AttributedString("Turn on ") + app
      + AttributedString(" under \(access.settingsListName(guide.permission))")
  }

  @ViewBuilder private var footer: some View {
    if guide.permission.appliesWithoutRelaunch {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Waiting for access…")
          .font(.system(size: 12))
          .foregroundStyle(Theme.mutedText)
        Spacer(minLength: 8)
        Button("Done") { access.finishGuide() }
          .buttonStyle(.guideSecondary)
          .font(.system(size: 12, weight: .medium))
      }
    } else {
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        Button("Later") { access.finishGuide() }
          .buttonStyle(.guideSecondary)
        if access.relaunchUnavailableReason == nil {
          Button(access.isRelaunching ? "Relaunching…" : "Relaunch Now") { access.relaunch() }
            .buttonStyle(.guidePrimary)
            .disabled(access.isRelaunching)
        }
      }
      .font(.system(size: 12, weight: .medium))
    }
  }
}

/// The permission is on; the next one is a click away.
private struct GuideGranted: View {
  let access: ComputerAccessSetup
  let permission: ComputerPermission

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        GuideCheck(size: 26)
        Text("\(permission.title) is on")
          .font(.system(size: 15, weight: .semibold))
      }
      if let next = access.nextPermission {
        Text(Self.pitch(for: next))
          .font(.system(size: 12))
          .foregroundStyle(Theme.mutedText)
          .fixedSize(horizontal: false, vertical: true)
      }
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        Button(access.nextPermission == nil ? "Done" : "Later") { access.finishGuide() }
          .buttonStyle(.guideSecondary)
        if let next = access.nextPermission {
          Button("Next: \(next.title)") { access.continueGuide() }
            .buttonStyle(.guidePrimary)
        }
      }
      .font(.system(size: 12, weight: .medium))
    }
  }

  static func pitch(for next: ComputerPermission) -> String {
    switch next {
    case .accessibility: "Next, Accessibility lets agents click and type in other apps."
    case .screenRecording: "Next, Screen Recording lets agents see the windows of other apps."
    }
  }
}

/// Everything's on; the guide closes by itself and Daily Do List comes back.
private struct GuideAllSet: View {
  var body: some View {
    HStack(spacing: 12) {
      GuideCheck(size: 30)
      VStack(alignment: .leading, spacing: 2) {
        Text("All set").font(.system(size: 15, weight: .semibold))
        Text("Agents can use your apps now. They ask before every action.")
          .font(.system(size: 12))
          .foregroundStyle(Theme.mutedText)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

/// "STEP 1 OF 2 · ACCESSIBILITY".
private struct GuideCaption: View {
  let permission: ComputerPermission
  let stepLabel: String?

  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: permission.systemImage)
        .font(.system(size: 10, weight: .semibold))
      Text([stepLabel, permission.title].compactMap { $0 }.joined(separator: " · ").uppercased())
        .font(.system(size: 10, weight: .semibold))
        .tracking(0.6)
    }
    .foregroundStyle(Theme.accent)
  }
}

/// A green check that pops in.
private struct GuideCheck: View {
  let size: CGFloat
  @State private var shown = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Image(systemName: "checkmark.circle.fill")
      .font(.system(size: size))
      .symbolRenderingMode(.palette)
      .foregroundStyle(.white, Theme.success)
      .scaleEffect(shown || reduceMotion ? 1 : 0.4)
      .opacity(shown || reduceMotion ? 1 : 0)
      .onAppear {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.55)) { shown = true }
      }
      .accessibilityHidden(true)
  }
}

private struct GuideNote: View {
  let systemImage: String
  let text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: systemImage)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Theme.accent)
      Text(text)
        .font(.system(size: 12))
        .foregroundStyle(Theme.mutedText)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

/// The app's icon, to drag into System Settings' list when Daily Do List isn't in it.
private struct AppIconDragWell: View {
  let icon: NSImage
  let bundleURL: URL
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 12) {
      Image(nsImage: icon)
        .resizable()
        .interpolation(.high)
        .frame(width: 44, height: 44)
        .scaleEffect(hovering ? 1.07 : 1)
        .shadow(color: .black.opacity(hovering ? 0.28 : 0.14), radius: hovering ? 6 : 3, y: 2)
        .accessibilityHidden(true)
        .overlay(AppIconDragSource(icon: icon, bundleURL: bundleURL))
      VStack(alignment: .leading, spacing: 2) {
        Text("Not in the list?")
          .font(.system(size: 12, weight: .semibold))
        Text("Drag this icon into it.")
          .font(.system(size: 12))
          .foregroundStyle(Theme.mutedText)
      }
      Spacer(minLength: 0)
    }
    .padding(10)
    .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(Theme.accent.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
    )
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.15), value: hovering)
  }
}

extension ButtonStyle where Self == AccentButtonStyle {
  /// The guide's main action.
  fileprivate static var guidePrimary: AccentButtonStyle {
    AccentButtonStyle(horizontalPadding: 12, verticalPadding: 5)
  }
}

extension ButtonStyle where Self == ChromeButtonStyle {
  /// The guide's other actions.
  fileprivate static var guideSecondary: ChromeButtonStyle {
    ChromeButtonStyle(
      horizontalPadding: 10, verticalPadding: 5, showsBorder: true, brightensLabel: true)
  }
}
