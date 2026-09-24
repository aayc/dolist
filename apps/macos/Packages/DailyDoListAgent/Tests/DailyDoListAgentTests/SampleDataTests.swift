import AppKit
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListAgent

@Suite("Sample data")
struct SampleDataTests {
  let snapshot = SampleData.snapshot(now: FormattingTests.now)

  @Test func referencesResolve() {
    let approvalIds = Set(snapshot.approvals.map(\.id))
    for thread in snapshot.loadedThreads {
      let artifactIds = Set(thread.artifacts.map(\.id))
      #expect(Set(thread.messages.map(\.id)).count == thread.messages.count)
      for message in thread.messages {
        switch message {
        case .approval(let item): #expect(approvalIds.contains(item.approvalId))
        case .artifact(let item):
          #expect(artifactIds.contains(item.artifactId))
          #expect(snapshot.artifacts[item.artifactId] != nil)
        default: break
        }
      }
      for artifact in thread.artifacts { #expect(snapshot.artifacts[artifact.id] != nil, "\(artifact.id) has a body") }
    }
    #expect(Set(snapshot.records.map(\.taskId)).count == snapshot.records.count)
    #expect(Set(snapshot.threads.map(\.id)).count == snapshot.threads.count)
  }

  /// Threads that cite pages carry them in `sources`; every numbered citation is one of them.
  @Test func citationsHaveTheirSources() throws {
    for id in [SampleData.desksThreadId, SampleData.questionThreadId] {
      let thread = try #require(snapshot.loadedThreads.first { $0.id == id })
      let sources = try #require(thread.sources)
      let text = thread.messages.compactMap { message -> String? in
        if case .text(let text) = message { return text.text }
        return nil
      }.joined(separator: "\n")
      let rendered = MarkdownRenderer.blocks(from: text)
      var citations = 0
      for block in rendered {
        guard case .paragraph(_, let paragraph) = block else { continue }
        for run in paragraph.runs {
          guard let url = run.link, LinkPreview.isCitationLabel(String(paragraph[run.range].characters)) else { continue }
          citations += 1
          #expect(CitedSourceMatch.source(for: url.absoluteString, in: sources) != nil, "\(url) is a source of \(id)")
        }
      }
      #expect(citations >= 2)
      #expect(text.contains("[["), "\(id) links a note")
    }
  }

  @Test func theBookingThreadHasEveryMessageKind() throws {
    let booking = try #require(snapshot.loadedThreads.first { $0.id == SampleData.bookingThreadId })
    #expect(Set(booking.messages.map(\.kind)) == ["text", "tool_call", "approval", "artifact", "status"])
    let statuses = booking.messages.compactMap { message -> ToolCallStatus? in
      if case .toolCall(let call) = message { return call.status }
      return nil
    }
    #expect(Set(statuses) == [.ok, .error, .blocked, .running])
    let roles = booking.messages.compactMap { message -> MessageRole? in
      if case .text(let text) = message { return text.role }
      return nil
    }
    #expect(Set(roles) == [.agent, .user, .system])
    #expect(booking.messages.contains { if case .text(let text) = $0 { text.streaming == true } else { false } })
  }

  @Test func framesAreRealImagesOfTheDeclaredSize() throws {
    for frame in snapshot.frames {
      let image = try #require(frame.imageData.flatMap(NSImage.init(data:)))
      let bitmap = try #require(image.representations.first as? NSBitmapImageRep)
      #expect(bitmap.pixelsWide == frame.width)
      #expect(bitmap.pixelsHigh == frame.height)
    }
  }

  @MainActor
  @Test func aSampleStoreIsReadyToRender() async throws {
    let store = SampleData.makeStore(now: FormattingTests.now)
    #expect(store.pendingApprovalCount == 2)
    #expect(store.todayNotePath == snapshot.dailyNotePath)
    #expect(store.records(for: snapshot.dailyNotePath).count == 10)
    let anchored = try #require(store.record(forThread: SampleData.questionThreadId))
    #expect(anchored.anchor == .line)
    #expect(anchored.taskId == SampleData.questionAnchorId)
    let sections = store.inboxSections(now: FormattingTests.now)
    #expect(sections.map(\.group) == [.needsYou, .working, .done, .other])
    #expect(sections.first?.threads.map(\.id).contains(SampleData.bookingThreadId) == true)
    #expect(!sections.flatMap(\.threads).contains { $0.id == SampleData.libraryThreadId }, "yesterday's done task is hidden")
    #expect(store.latestFrame(threadId: SampleData.bookingThreadId, surface: .browser) != nil)
    #expect(store.recentActions(threadId: SampleData.coffeeThreadId, surface: .computer).count == 1)

    // Actions work against the sample client.
    #expect(await store.decide(SampleData.reserveApprovalId, .approve, scope: .once))
    #expect(store.pendingApprovalCount == 1)
    let payload = try await store.fetchArtifact(threadId: SampleData.desksThreadId, artifactId: "art_sample_desks")
    #expect(String(decoding: payload.data, as: UTF8.self).hasPrefix("# Standing desks"))
  }

  @Test func theSampleClientServesAndUpdatesTheSample() async throws {
    let client = SampleDaemonClient(snapshot: snapshot)
    let pending = try await client.approvals(status: .pending)
    #expect(pending.count == 2)
    let decided = try await client.decideApproval(SampleData.emailApprovalId, ApprovalDecisionRequest(decision: .deny, note: "Not yet"))
    #expect(decided.status == .denied)
    #expect(decided.decisionNote == "Not yet")
    await #expect(throws: (any Error).self) {
      _ = try await client.decideApproval(SampleData.emailApprovalId, ApprovalDecisionRequest(decision: .approve))
    }
    let status = try await client.setAgentEnabled(false)
    #expect(!status.enabled)
    await #expect(throws: (any Error).self) { _ = try await client.tree() }
    await client.send(.threadRead(threadId: "thr"))
    #expect(client.sent == [.threadRead(threadId: "thr")])
  }
}
