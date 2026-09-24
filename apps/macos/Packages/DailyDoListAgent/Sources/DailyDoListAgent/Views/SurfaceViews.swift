import DailyDoListModels
import SwiftUI

/// The agent's headless browser: latest frame scaled to fit, URL and title, a "Live" indicator
/// while frames keep coming, and a marker where the last action happened. Frames only stream
/// while this view is on screen.
public struct BrowserSurfaceView: View {
  let store: AgentStore
  let threadId: String

  public init(store: AgentStore, threadId: String) {
    self.store = store
    self.threadId = threadId
  }

  public var body: some View {
    let frame = store.latestFrame(threadId: threadId, surface: .browser)
    VStack(spacing: 0) {
      SurfaceBar(
        systemImage: "globe", title: frame?.url ?? "Waiting for the browser…",
        subtitle: frame?.title, lastFrameAt: frame?.ts, monospacedTitle: frame?.url != nil)
      SurfaceStage(
        image: frame.flatMap { store.image(for: $0) }, frame: frame,
        markers: frame.map(Self.markers(for:)) ?? [],
        emptyText: "No frames yet — they stream here while the agent browses.")
    }
    .surfaceSubscription(store: store, key: SurfaceKey(threadId: threadId, surface: .browser))
  }

  static func markers(for frame: SurfaceFrame) -> [SurfaceMarker] {
    guard let action = frame.action, let x = action.x, let y = action.y else { return [] }
    return [SurfaceMarker(id: "\(frame.ts)", x: x, y: y, label: action.text ?? action.kind, opacity: 1)]
  }
}

/// The desktop the agent controls: latest screenshot with the last few clicks, and a log of
/// recent actions.
public struct ComputerSurfaceView: View {
  let store: AgentStore
  let threadId: String
  @Environment(\.agentReferenceDate) private var referenceDate

  static let markerCount = 5

  public init(store: AgentStore, threadId: String) {
    self.store = store
    self.threadId = threadId
  }

  public var body: some View {
    let frame = store.latestFrame(threadId: threadId, surface: .computer)
    let actions = store.recentActions(threadId: threadId, surface: .computer)
    VStack(spacing: 0) {
      SurfaceBar(systemImage: "desktopcomputer", title: "Computer use", subtitle: nil, lastFrameAt: frame?.ts)
      SurfaceStage(
        image: frame.flatMap { store.image(for: $0) }, frame: frame,
        markers: Self.markers(for: actions),
        emptyText: "No screenshots yet — they appear here while the agent uses the computer.")
      AgentHairline()
      actionLog(actions)
    }
    .surfaceSubscription(store: store, key: SurfaceKey(threadId: threadId, surface: .computer))
  }

  /// The last clicks, older ones fading out; only the newest is labeled.
  static func markers(for actions: [SurfaceAction]) -> [SurfaceMarker] {
    let clicks = actions.filter { $0.x != nil && $0.y != nil }.suffix(markerCount)
    return clicks.enumerated().map { index, action in
      SurfaceMarker(
        id: action.id, x: action.x ?? 0, y: action.y ?? 0,
        label: index == clicks.count - 1 ? action.kind : nil,
        opacity: Double(index + 1) / Double(clicks.count))
    }
  }

  private func actionLog(_ actions: [SurfaceAction]) -> some View {
    let now = referenceDate ?? Date()
    return VStack(alignment: .leading, spacing: 4) {
      Text("Actions").font(.caption.weight(.semibold)).foregroundStyle(AgentTheme.mutedText)
      if actions.isEmpty {
        Text("Nothing yet.").font(.caption).foregroundStyle(AgentTheme.faint)
      } else {
        ScrollView {
          VStack(alignment: .leading, spacing: 3) {
            ForEach(actions.reversed()) { action in
              HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: AgentFormat.timestamp(action.ts, now: now))
                  .foregroundStyle(AgentTheme.faint)
                  .monospacedDigit()
                Text(verbatim: action.summary).lineLimit(1).truncationMode(.middle)
              }
              .font(.caption)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 120)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }
}

/// A marker drawn over a frame, in frame pixels.
struct SurfaceMarker: Identifiable, Hashable {
  var id: String
  var x: Double
  var y: Double
  var label: String?
  var opacity: Double
}

enum SurfaceGeometry {
  /// Maps a point in frame pixels into a view showing the whole frame at `viewSize`.
  static func point(x: Double, y: Double, frameWidth: Int, frameHeight: Int, viewSize: CGSize) -> CGPoint {
    func fraction(_ value: Double, of size: Int) -> Double {
      let ratio = value / Double(max(size, 1))
      return ratio.isFinite ? min(max(ratio, 0), 1) : 0
    }
    return CGPoint(
      x: fraction(x, of: frameWidth) * viewSize.width, y: fraction(y, of: frameHeight) * viewSize.height)
  }
}

private struct SurfaceBar: View {
  let systemImage: String
  let title: String
  let subtitle: String?
  let lastFrameAt: EpochMillis?
  var monospacedTitle = false
  @Environment(\.agentReferenceDate) private var referenceDate

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let live = SurfaceFeed.isLive(lastFrameAt: lastFrameAt, now: referenceDate ?? context.date)
      HStack(spacing: 8) {
        LiveBadge(isLive: live)
        Image(systemName: systemImage).foregroundStyle(AgentTheme.mutedText)
        VStack(alignment: .leading, spacing: 1) {
          Text(verbatim: title)
            .font(monospacedTitle ? .system(size: 11.5, design: .monospaced) : .callout)
            .lineLimit(1)
            .truncationMode(.middle)
            .textSelection(.enabled)
          if let subtitle, !subtitle.isEmpty {
            Text(verbatim: subtitle).font(.caption).foregroundStyle(AgentTheme.mutedText).lineLimit(1)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(RoundedRectangle(cornerRadius: 7).fill(AgentTheme.subtleFill))
      .padding(.horizontal, 12)
      .padding(.top, 10)
    }
  }
}

private struct LiveBadge: View {
  let isLive: Bool

  var body: some View {
    HStack(spacing: 4) {
      Circle().fill(isLive ? AgentTheme.danger : AgentTheme.faint).frame(width: 7, height: 7)
      Text(isLive ? "Live" : "Idle")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(isLive ? AgentTheme.danger : AgentTheme.mutedText)
    }
    .accessibilityElement(children: .combine)
  }
}

private struct SurfaceStage: View {
  let image: NSImage?
  let frame: SurfaceFrame?
  let markers: [SurfaceMarker]
  let emptyText: String

  var body: some View {
    Group {
      if let image, let frame {
        Image(nsImage: image)
          .resizable()
          .interpolation(.high)
          .aspectRatio(CGSize(width: max(frame.width, 1), height: max(frame.height, 1)), contentMode: .fit)
          .overlay {
            GeometryReader { geometry in
              ForEach(markers) { marker in
                ActionMarker(label: marker.label)
                  .opacity(marker.opacity)
                  .position(
                    SurfaceGeometry.point(
                      x: marker.x, y: marker.y, frameWidth: frame.width, frameHeight: frame.height,
                      viewSize: geometry.size))
              }
            }
          }
          .clipShape(RoundedRectangle(cornerRadius: 6))
          .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(AgentTheme.border))
          .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
          .accessibilityLabel(frame.title ?? "Latest frame")
      } else {
        ContentUnavailableView {
          Label("No frames yet", systemImage: "rectangle.dashed")
        } description: {
          Text(verbatim: emptyText)
        }
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

private struct ActionMarker: View {
  let label: String?

  var body: some View {
    ZStack {
      Circle().fill(AgentTheme.accent.opacity(0.25)).frame(width: 24, height: 24)
      Circle().strokeBorder(AgentTheme.accent, lineWidth: 2).frame(width: 24, height: 24)
      Circle().fill(AgentTheme.accent).frame(width: 6, height: 6)
    }
    .overlay(alignment: .top) {
      if let label, !label.isEmpty {
        Text(verbatim: label)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.white)
          .lineLimit(1)
          .fixedSize()
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Capsule().fill(AgentTheme.accent))
          .offset(y: 28)
      }
    }
    .allowsHitTesting(false)
  }
}

extension View {
  /// Subscribes to a surface while the view is on screen.
  func surfaceSubscription(store: AgentStore, key: SurfaceKey) -> some View {
    task(id: key) {
      store.subscribe(threadId: key.threadId, surface: key.surface)
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(3600))
      }
      store.unsubscribe(threadId: key.threadId, surface: key.surface)
    }
  }
}
