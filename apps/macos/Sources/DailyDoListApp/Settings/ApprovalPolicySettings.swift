import DailyDoListModels
import DailyDoListUI
import SwiftUI

extension ApprovalPolicy {
  /// What stays blocked under every policy: the hard-deny rules and protected apps, in plain words.
  static let neverAllowed =
    "deleting your home folder, reading passwords or keychains, controlling Daily Do List itself, System Settings or password managers"

  /// The policy's choice in Settings → Agent → Approvals (the web app's words).
  var settingsLabel: String {
    switch self {
    case .askEveryAction: "Ask before every action"
    case .askRisky: "Ask for risky actions (recommended)"
    case .askHighRisk: "Ask only for high-risk actions"
    case .runEverything: "Run everything"
    }
  }

  /// What the choice means, shown under it.
  var settingsDescription: String {
    switch self {
    case .askEveryAction:
      "Every action that changes something asks first. Reading, searching and research don't."
    case .askRisky:
      "The safety check decides: purchases, messages, bookings, deletions, account changes and anything it can't verify ask first."
    case .askHighRisk:
      "Only high-risk actions ask first (sending messages, paying, deleting, account and credential changes); everything else runs."
    case .runEverything:
      "Agents never ask. Actions that are never allowed stay blocked: \(Self.neverAllowed)."
    }
  }

  /// Choosing it asks for confirmation first.
  var needsConfirmation: Bool { self == .runEverything }
}

/// The alert before choosing "Run everything".
enum RunEverythingConfirmation {
  static let title = "Run everything without asking?"
  static let message =
    "Agents will act without asking you first: they can buy things, send messages, book, delete files and run programs on their own. Actions that are never allowed stay blocked: \(ApprovalPolicy.neverAllowed)."
  static let confirm = "Run everything"
}

/// Settings → Agent → Approvals: one radio button per policy with its description underneath.
/// "Run everything" is saved only once the alert confirms it.
struct ApprovalPolicyPicker: View {
  let selection: ApprovalPolicy
  let onChange: (ApprovalPolicy) -> Void
  @State private var confirming = false

  var body: some View {
    Picker(
      "Approvals",
      selection: Binding(get: { selection }, set: { choose($0) })
    ) {
      ForEach(ApprovalPolicy.allCases, id: \.self) { policy in
        VStack(alignment: .leading, spacing: 2) {
          Text(policy.settingsLabel)
          Text(policy.settingsDescription)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 3)
        .tag(policy)
      }
    }
    .pickerStyle(.radioGroup)
    .labelsHidden()
    .pointingHandCursor()
    .alert(RunEverythingConfirmation.title, isPresented: $confirming) {
      Button(RunEverythingConfirmation.confirm, role: .destructive) {
        onChange(.runEverything)
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(RunEverythingConfirmation.message)
    }
  }

  /// What picking `policy` does while `current` is selected.
  enum Choice: Equatable {
    case unchanged
    case confirm
    case save(ApprovalPolicy)
  }

  static func choice(_ policy: ApprovalPolicy, current: ApprovalPolicy) -> Choice {
    if policy == current { return .unchanged }
    return policy.needsConfirmation ? .confirm : .save(policy)
  }

  private func choose(_ policy: ApprovalPolicy) {
    switch Self.choice(policy, current: selection) {
    case .unchanged: break
    case .confirm: confirming = true
    case .save(let policy): onChange(policy)
    }
  }
}

/// The status bar item while the approval policy isn't the default (the web app's wording).
struct ApprovalPolicyIndicator: Equatable {
  let label: String
  let tooltip: String
  let systemImage: String
  let isWarning: Bool

  init?(_ policy: ApprovalPolicy) {
    switch policy {
    case .askRisky:
      return nil
    case .runEverything:
      label = "Runs everything"
      tooltip = "Agents run everything without asking — click to change"
      systemImage = "shield.slash"
      isWarning = true
    case .askHighRisk:
      label = "Asks only for high-risk"
      tooltip = "Agents ask only before high-risk actions — click to change"
      systemImage = "checkmark.shield"
      isWarning = false
    case .askEveryAction:
      label = "Asks before every action"
      tooltip = "Agents ask before every action that changes something — click to change"
      systemImage = "checkmark.shield"
      isWarning = false
    }
  }
}
