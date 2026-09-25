import DailyDoListModels

// Labels, tones and symbols for wire enums (web: features/agent/status-meta.ts). Values this
// build doesn't know fall back to a readable form of the raw value and a neutral tone.

extension TaskAgentStatus {
  /// "Working", "Needs approval"…
  public var displayLabel: String {
    switch self {
    case .idle: "Idle"
    case .triaging: "Triaging"
    case .queued: "Queued"
    case .working: "Working"
    case .waitingApproval: "Needs approval"
    case .waitingUser: "Needs you"
    case .done: "Done"
    case .failed: "Failed"
    case .cancelled: "Stopped"
    case .ignored: "Ignored"
    default: humanize(rawValue)
    }
  }

  public var tone: Tone {
    switch self {
    case .triaging: .accent
    case .working: .info
    case .waitingApproval, .waitingUser: .warning
    case .done: .success
    case .failed: .danger
    default: .faint
    }
  }

  /// The orchestrator is thinking: the badge pulses.
  public var pulses: Bool { self == .triaging }

  /// An agent is at work (the thread header's status chip pulses).
  public var isRunning: Bool { self == .triaging || self == .working }

  /// SF Symbol for the status.
  public var systemImage: String {
    switch self {
    case .idle: "circle.dotted"
    case .triaging: "sparkles"
    case .queued: "clock"
    case .working: "circle.dashed"
    case .waitingApproval: "exclamationmark.shield.fill"
    case .waitingUser: "questionmark.bubble.fill"
    case .done: "checkmark.circle.fill"
    case .failed: "xmark.octagon.fill"
    case .cancelled: "stop.circle"
    case .ignored: "minus.circle"
    default: "circle"
    }
  }
}

extension ActionCategory {
  /// "Spends money", "Contacts someone"…
  public var displayLabel: String {
    switch self {
    case .read: "Read"
    case .compute: "Compute"
    case .network: "Network"
    case .fileWrite: "Writes files"
    case .browserInput: "Browser input"
    case .formSubmission: "Submits a form"
    case .computerControl: "Controls the computer"
    case .communication: "Contacts someone"
    case .publishing: "Publishes"
    case .payment: "Spends money"
    case .booking: "Makes a booking"
    case .account: "Account change"
    case .credentials: "Credentials"
    case .privacy: "Privacy"
    case .destructive: "Destructive"
    case .system: "System"
    case .unknown: "Unknown"
    default: humanize(rawValue)
    }
  }
}

extension RiskLevel {
  /// "High risk"
  public var displayLabel: String {
    switch self {
    case .low: "Low risk"
    case .medium: "Medium risk"
    case .high: "High risk"
    case .critical: "Critical risk"
    default: "\(humanize(rawValue)) risk"
    }
  }

  public var tone: Tone {
    switch self {
    case .low: .success
    case .medium: .warning
    case .high, .critical: .danger
    default: .warning
    }
  }
}

extension ToolCallStatus {
  public var displayLabel: String {
    switch self {
    case .running: "Running"
    case .ok: "Succeeded"
    case .error: "Failed"
    case .blocked: "Blocked by safety policy"
    default: humanize(rawValue)
    }
  }

  public var tone: Tone {
    switch self {
    case .running: .info
    case .ok: .success
    case .error: .danger
    case .blocked: .warning
    default: .faint
    }
  }

  /// SF Symbol (running shows a spinner instead).
  public var systemImage: String {
    switch self {
    case .ok: "checkmark.circle.fill"
    case .error: "xmark.circle.fill"
    case .blocked: "shield.lefthalf.filled"
    default: "circle.dotted"
    }
  }
}

extension ApprovalStatus {
  public var tone: Tone {
    switch self {
    case .pending: .warning
    case .approved: .success
    case .denied: .danger
    default: .faint
    }
  }

  public var systemImage: String {
    switch self {
    case .pending: "exclamationmark.shield.fill"
    case .approved: "checkmark.shield.fill"
    default: "xmark.shield.fill"
    }
  }
}

extension ArtifactKind {
  /// "Markdown", "JSON", "HTML"…
  public var displayLabel: String {
    switch self {
    case .json: "JSON"
    case .html: "HTML"
    case .code: "Code"
    default: humanize(rawValue)
    }
  }

  public var systemImage: String {
    switch self {
    case .markdown: "doc.richtext"
    case .code: "chevron.left.forwardslash.chevron.right"
    case .html: "globe"
    case .image: "photo"
    case .json: "curlybraces"
    case .text: "doc.text"
    default: "doc"
    }
  }
}

extension ArtifactMeta {
  /// Kind label, with the language for code ("python").
  public var kindLabel: String {
    if kind == .code, let language, !language.isEmpty { return language }
    return kind.displayLabel
  }
}

/// "waiting_for_input" → "Waiting for input"
func humanize(_ raw: String) -> String {
  let words = raw.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
  guard let first = words.first else { return raw }
  return first.uppercased() + words.dropFirst()
}
