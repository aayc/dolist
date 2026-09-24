import SwiftUI

/// Unobtrusive notice while the daemon connection is lost (after having been connected).
struct OfflineBanner: View {
  let model: AppModel
  @State private var retrying = false

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "wifi.slash")
      Text("Can't reach the daemon. Reconnecting… Your edits are kept and saved when it's back.")
        .lineLimit(1)
        .truncationMode(.tail)
      Spacer()
      Button(retrying ? "Retrying…" : "Retry") {
        retrying = true
        Task {
          await model.retry()
          retrying = false
        }
      }
      .controlSize(.small)
      .disabled(retrying)
    }
    .font(.system(size: 12))
    .foregroundStyle(Theme.text)
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(Theme.warning.opacity(0.16))
    .accessibilityElement(children: .contain)
  }
}

/// Stack of toasts (bottom-right).
struct ToastOverlay: View {
  let toasts: ToastStore

  var body: some View {
    VStack(alignment: .trailing, spacing: 8) {
      ForEach(toasts.toasts) { toast in
        ToastView(toast: toast, toasts: toasts)
          .transition(.move(edge: .trailing).combined(with: .opacity))
      }
    }
    .animation(.snappy(duration: 0.2), value: toasts.toasts.map(\.id))
  }
}

private struct ToastView: View {
  let toast: Toast
  let toasts: ToastStore

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: icon).foregroundStyle(color)
      VStack(alignment: .leading, spacing: 3) {
        Text(toast.title).font(.system(size: 12, weight: .semibold))
        if let body = toast.body {
          Text(body).font(.system(size: 12)).foregroundStyle(Theme.mutedText)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let label = toast.actionLabel {
          Button(label) { toasts.performAction(toast) }
            .buttonStyle(.link)
            .font(.system(size: 12, weight: .medium))
        }
      }
      Spacer(minLength: 0)
      Button {
        toasts.dismiss(toast.id)
      } label: {
        Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(
          Theme.faintText)
      }
      .buttonStyle(.plain)
      .help("Dismiss")
    }
    .padding(12)
    .frame(width: 320)
    .background(Theme.elevated, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border))
    .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
  }

  private var icon: String {
    switch toast.kind {
    case .info: "info.circle.fill"
    case .success: "checkmark.circle.fill"
    case .warning: "exclamationmark.triangle.fill"
    case .error: "xmark.octagon.fill"
    }
  }

  private var color: Color {
    switch toast.kind {
    case .info: Theme.info
    case .success: Theme.success
    case .warning: Theme.warning
    case .error: Theme.danger
    }
  }
}
