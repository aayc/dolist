import DailyDoListUI
import SwiftUI

/// Settings → Computer Use: what agents can do in other apps, the guardrails, and the two macOS
/// permissions it takes, each one click away from its list in System Settings. Statuses update
/// live while the pane shows.
struct ComputerUseSettingsPane: View {
  let model: AppModel
  let access: ComputerAccessSetup
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Form {
      Section {
        ComputerUseIntro(isComplete: access.isComplete)
      }
      Section("Access") {
        ForEach(ComputerPermission.allCases) { permission in
          PermissionRow(
            permission: permission, status: access.status(permission),
            isNextStep: nextStep == .allow(permission)
          ) {
            access.request(permission)
          }
        }
        if access.needsRelaunch {
          RelaunchRow(access: access, isNextStep: nextStep == .relaunch)
        }
        if let problem = access.problem {
          SettingsNote(text: problem, tone: Theme.danger)
        }
        if access.isComplete {
          SettingsCallout(
            systemImage: "sparkles", tint: Theme.accent,
            text:
              "Agents can use your apps now. Try a task like “Start a packing list in Notes”."
          )
          .transition(.opacity)
        }
      }
      if let note = model.daemonHost.permissionsNote {
        Section {
          SettingsCallout(
            systemImage: "exclamationmark.triangle.fill", tint: Theme.warning, text: note)
        }
      }
      if access.isSignedAdHoc {
        Section {
          SettingsCallout(
            systemImage: "info.circle", tint: Theme.info,
            text:
              "This copy is signed ad hoc, so macOS forgets these permissions each time the app is rebuilt. Building it yourself? Run `apps/macos/scripts/signing-identity.sh --create` once."
          )
        }
      }
    }
    .formStyle(.grouped)
    .animation(motion, value: access.accessibility)
    .animation(motion, value: access.screenRecording)
    .onAppear { access.settingsPaneAppeared() }
    .onDisappear { access.settingsPaneDisappeared() }
  }

  private var motion: Animation {
    reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.35, dampingFraction: 0.72)
  }

  /// The one button that stands out: the first permission to allow, then the relaunch.
  private var nextStep: ComputerUseNextStep? {
    if let permission = access.missing.first(where: { access.status($0) == .notGranted }) {
      return .allow(permission)
    }
    return access.needsRelaunch ? .relaunch : nil
  }
}

private enum ComputerUseNextStep: Equatable {
  case allow(ComputerPermission)
  case relaunch
}

/// The pane's header: what computer use is, and its guardrails.
private struct ComputerUseIntro: View {
  let isComplete: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 14) {
        ZStack(alignment: .bottomTrailing) {
          Image(systemName: "cursorarrow.click.2")
            .font(.system(size: 22, weight: .medium))
            .foregroundStyle(Theme.accent)
            .frame(width: 44, height: 44)
            .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 10))
          if isComplete {
            Image(systemName: "checkmark.circle.fill")
              .font(.system(size: 16))
              .symbolRenderingMode(.palette)
              .foregroundStyle(.white, Theme.success)
              .offset(x: 5, y: 5)
              .transition(.scale(scale: 0.4).combined(with: .opacity))
          }
        }
        VStack(alignment: .leading, spacing: 4) {
          Text("Computer Use").font(.title3.weight(.semibold))
          Text(
            "Let agents use the apps on this Mac that have no connector or browser. They read what's on screen, then click and type for you."
          )
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        }
      }
      VStack(alignment: .leading, spacing: 8) {
        GuardrailRow(
          systemImage: "hand.raised", text: "Asks before every action it takes in another app.")
        GuardrailRow(
          systemImage: "eye", text: "May look at other apps' windows to see what's there.")
        GuardrailRow(
          systemImage: "lock.shield",
          text: "Never touches Daily Do List, System Settings or password managers.")
      }
      .padding(.leading, 58)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
  }
}

private struct GuardrailRow: View {
  let systemImage: String
  let text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: systemImage)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Theme.accent)
        .frame(width: 16)
      Text(text).font(.callout)
    }
  }
}

/// A permission, what it's for, and its state: "Allow…" until it's on.
private struct PermissionRow: View {
  let permission: ComputerPermission
  let status: ComputerPermissionStatus
  let isNextStep: Bool
  let request: () -> Void

  var body: some View {
    LabeledContent {
      trailing
    } label: {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: permission.systemImage)
          .font(.system(size: 15))
          .foregroundStyle(status == .granted ? Theme.success : Theme.accent)
          .frame(width: 22)
        VStack(alignment: .leading, spacing: 2) {
          Text(permission.title)
          Text(permission.purpose)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityValue(accessibilityValue)
  }

  @ViewBuilder private var trailing: some View {
    switch status {
    case .granted:
      Label("On", systemImage: "checkmark.circle.fill")
        .foregroundStyle(Theme.success)
        .fontWeight(.medium)
        .transition(.scale(scale: 0.5).combined(with: .opacity))
    case .notGranted:
      Button("Allow…", action: request)
        .nextStepStyle(isNextStep)
        .pointingHandCursor()
    case .awaitingRelaunch:
      Button("Open Settings…", action: request)
        .pointingHandCursor()
    }
  }

  private var accessibilityValue: String {
    switch status {
    case .granted: "On"
    case .notGranted: "Off"
    case .awaitingRelaunch: "Applies after a relaunch"
    }
  }
}

/// Screen Recording applies after a relaunch.
private struct RelaunchRow: View {
  let access: ComputerAccessSetup
  let isNextStep: Bool

  var body: some View {
    LabeledContent {
      Button(access.isRelaunching ? "Relaunching…" : "Relaunch Now") { access.relaunch() }
        .nextStepStyle(isNextStep)
        .pointingHandCursor()
        .disabled(access.isRelaunching || access.relaunchUnavailableReason != nil)
    } label: {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "arrow.clockwise")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(Theme.warning)
          .frame(width: 22)
        VStack(alignment: .leading, spacing: 2) {
          Text("Relaunch to finish")
          Text(
            access.relaunchUnavailableReason
              ?? "Turned on Screen Recording? macOS applies it once Daily Do List relaunches."
          )
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .transition(.opacity.combined(with: .move(edge: .top)))
  }
}

extension View {
  /// The button of the setup's next step stands out.
  @ViewBuilder fileprivate func nextStepStyle(_ isNextStep: Bool) -> some View {
    if isNextStep { buttonStyle(.borderedProminent) } else { self }
  }
}

/// An icon and a note, for things worth knowing that aren't errors. `code` spans show as code.
struct SettingsCallout: View {
  let systemImage: String
  let tint: Color
  let text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: systemImage).foregroundStyle(tint)
      Text(Self.inlineMarkdown(text))
        .font(.callout)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    }
  }

  static func inlineMarkdown(_ text: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
      interpretedSyntax: .inlineOnlyPreservingWhitespace)
    return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
  }
}
