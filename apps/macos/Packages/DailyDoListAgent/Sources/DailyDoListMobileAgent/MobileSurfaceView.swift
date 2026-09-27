#if canImport(UIKit)
  import DailyDoListAgentCore
  import DailyDoListModels
  import SwiftUI

  /// A view-only live feed. Subscription ends immediately when hidden or the scene leaves active.
  public struct MobileSurfaceView: View {
    let store: AgentStore
    let threadId: String
    let surface: SurfaceKind
    @State private var image: UIImage?
    @State private var subscribed = false
    @State private var visible = false
    @Environment(\.scenePhase) private var scenePhase

    private struct DecodeKey: Equatable {
      let timestamp: EpochMillis?
      let active: Bool
    }

    public init(store: AgentStore, threadId: String, surface: SurfaceKind) {
      self.store = store
      self.threadId = threadId
      self.surface = surface
    }

    public var body: some View {
      let frame = store.latestFrame(threadId: threadId, surface: surface)
      VStack(alignment: .leading, spacing: 8) {
        if visible && scenePhase == .active {
          TimelineView(.periodic(from: .now, by: 1)) { context in header(frame, now: context.date) }
        } else {
          header(frame, now: Date())
        }
        if let url = frame?.url { Text(url).font(.caption).lineLimit(2).textSelection(.enabled) }
        if let image {
          MobileZoomableImage(
            image: image, label: frame?.title ?? "Latest \(surface.rawValue) frame")
        } else {
          ContentUnavailableView(
            "No frames yet", systemImage: "rectangle.dashed",
            description: Text(
              "Frames appear while the agent uses this surface. You can view and zoom, but cannot send computer input."
            ))
        }
        let actions = store.recentActions(threadId: threadId, surface: surface)
        if !actions.isEmpty {
          DisclosureGroup("Recent actions") {
            ScrollView {
              LazyVStack(alignment: .leading, spacing: 6) {
                ForEach(actions.reversed()) { action in
                  Text("\(AgentFormat.timestamp(action.ts)) · \(action.summary)").font(.caption)
                }
              }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 160)
          }
        }
      }
      .padding()
      .onAppear {
        visible = true
        updateSubscription()
      }
      .onDisappear {
        visible = false
        updateSubscription()
        image = nil
      }
      .onChange(of: scenePhase) { _, _ in updateSubscription() }
      .task(id: DecodeKey(timestamp: frame?.ts, active: visible && scenePhase == .active)) {
        guard visible, scenePhase == .active, let data = frame?.imageData,
          let decoded = await MobileImageDecoder.shared.decode(data), !Task.isCancelled
        else { return }
        image = UIImage(cgImage: decoded.image)
      }
    }

    private func header(_ frame: SurfaceFrame?, now: Date) -> some View {
      HStack(alignment: .firstTextBaseline) {
        let live = SurfaceFeed.isLive(lastFrameAt: frame?.ts, now: now)
        Label(
          live ? "Live" : "Last received frame",
          systemImage: live ? "dot.radiowaves.left.and.right" : "clock"
        )
        .foregroundStyle(live ? Color.green : Color.secondary)
        Spacer()
        if let frame { Text(AgentFormat.timestamp(frame.ts)).font(.caption) }
      }.font(.subheadline)
    }

    private func updateSubscription() {
      let shouldSubscribe = visible && scenePhase == .active
      guard shouldSubscribe != subscribed else { return }
      subscribed = shouldSubscribe
      if shouldSubscribe {
        store.subscribe(threadId: threadId, surface: surface)
      } else {
        store.unsubscribe(threadId: threadId, surface: surface)
      }
    }
  }
#endif
