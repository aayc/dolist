import AppKit
import DailyDoListUI
import SwiftUI

/// Under the tabs while computer use isn't set up and the agent is on (``ComputerAccessBannerKind``):
/// "Set Up…" opens Settings → Computer Use, or, once Screen Recording waits for it, "Relaunch Now".
/// Dismissing it is remembered.
struct ComputerAccessBanner: View {
  let model: AppModel
  let kind: ComputerAccessBannerKind

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: kind == .setUp ? "sparkles" : "arrow.clockwise")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Theme.accent)
        .accessibilityHidden(true)
      Text(title)
        .fontWeight(.semibold)
        .foregroundStyle(Theme.text)
        .fixedSize()
      Text(detail)
        .foregroundStyle(Theme.mutedText)
        .lineLimit(1)
        .truncationMode(.tail)
        .tooltip(ifTruncated: detail, font: .systemFont(ofSize: 12))
      Spacer(minLength: 8)
      action
        .buttonStyle(AccentButtonStyle(horizontalPadding: 10, verticalPadding: 3))
        .font(.system(size: 12, weight: .medium))
        .fixedSize()
      IconButton("xmark", label: "Don't show again", size: .compact) {
        model.dismissComputerAccessBanner()
      }
    }
    .font(.system(size: 12))
    .padding(.leading, 12)
    .padding(.trailing, 6)
    .padding(.vertical, 5)
    .background(Theme.accentSoft)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder private var action: some View {
    switch kind {
    case .setUp:
      Button("Set Up…") { CommandCatalog(model: model).run(.setUpComputerUse) }
        .tooltip("Open Settings → Computer Use", command: .setUpComputerUse)
    case .relaunch:
      let access = model.computerAccess
      Button(access.isRelaunching ? "Relaunching…" : "Relaunch Now") { access.relaunch() }
        .disabled(access.isRelaunching || access.relaunchUnavailableReason != nil)
    }
  }

  private var title: String {
    switch kind {
    case .setUp: "Let the agent use your apps"
    case .relaunch: "Relaunch to finish setting up computer use"
    }
  }

  private var detail: String {
    switch kind {
    case .setUp:
      "It can work in apps that have no connector or browser, and asks before every action."
    case .relaunch: "macOS applies Screen Recording once Daily Do List relaunches."
    }
  }
}
