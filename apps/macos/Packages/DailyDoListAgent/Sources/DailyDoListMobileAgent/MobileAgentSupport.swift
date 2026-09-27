#if canImport(UIKit)
  import DailyDoListAgentCore
  import DailyDoListModels
  import SwiftUI

  extension Tone {
    var mobileColor: Color {
      switch self {
      case .accent: .accentColor
      case .faint: .secondary
      case .info: .blue
      case .warning: .orange
      case .success: .green
      case .danger: .red
      }
    }
  }

  struct MobileAgentNotice: View {
    let title: String
    var message: String?
    var systemImage = "info.circle"

    var body: some View {
      VStack(alignment: .leading, spacing: 6) {
        Label(title, systemImage: systemImage).font(.headline)
        if let message { Text(message).font(.subheadline).foregroundStyle(.secondary) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding()
      .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
      .accessibilityElement(children: .combine)
    }
  }

  struct MobileStatusLabel: View {
    let status: TaskAgentStatus
    var body: some View {
      Label(status.displayLabel, systemImage: status.systemImage)
        .font(.caption.weight(.medium))
        .foregroundStyle(status.tone.mobileColor)
    }
  }

  struct MobileJSONView: View {
    let text: String
    var body: some View {
      ScrollView(.horizontal) {
        Text(verbatim: text).font(.system(.caption, design: .monospaced))
          .textSelection(.enabled).fixedSize(horizontal: true, vertical: false)
          .padding(10)
      }
      .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }
  }

  struct MobileAgentError: ViewModifier {
    let store: AgentStore
    func body(content: Content) -> some View {
      content.alert(
        store.lastError?.title ?? "Action failed",
        isPresented: Binding(
          get: { store.lastError != nil }, set: { if !$0 { store.dismissError() } })
      ) {
        Button("OK", role: .cancel) { store.dismissError() }
      } message: {
        Text(store.lastError?.message ?? "")
      }
    }
  }
#endif
