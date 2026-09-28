import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

struct HTTPDaemonClientFileTests {
  let path = "Assets/Café #1.bin"
  let route = "/api/files/Assets/Caf%C3%A9%20%231.bin"
  let payload = Data([0, 255, 128, 13, 10, 195, 40])

  private func client(_ stub: Stub, workspace: String? = "workspace-test") -> HTTPDaemonClient {
    HTTPDaemonClient(
      endpoint: DaemonEndpoint(baseURL: stub.baseURL, token: "test-token"), session: stub.session,
      expectedWorkspaceId: workspace)
  }

  private func headers(path: String = "Assets/Caf%C3%A9%20%231.bin", size: Int = 7) -> [String:
    String]
  {
    [
      "X-DDL-File-Path": path, "X-DDL-File-Version": "version-1", "X-DDL-File-Mtime": "100",
      "Content-Type": "application/octet-stream", "Content-Length": String(size),
    ]
  }

  @Test func readsExactBytesWithAuthenticatedMetadata() async throws {
    let responseHeaders = headers()
    let data = payload
    let stub = Stub { _ in .respond(status: 200, headers: responseHeaders, body: data) }
    let result = try await client(stub).readFile(path)
    #expect(result.data == payload)
    #expect(result.metadata.path == path)
    #expect(result.metadata.version == "version-1")
    let request = try #require(stub.requests.first)
    #expect(request.target == route)
    #expect(request.header("Authorization") == "Bearer test-token")
    #expect(request.header("X-DDL-Workspace-Id") == "workspace-test")
  }

  @Test func writesRawConditionalBytesAndSoftDeletes() async throws {
    let metadata = VaultFileMetadata(
      path: path, version: "version-2", mtime: 101, size: payload.count,
      mimeType: "application/octet-stream")
    let stub = Stub { request in
      request.method == "DELETE"
        ? .json(#"{"ok":true,"trashedTo":".trash/Assets/example.bin"}"#)
        : .json(201, value: metadata)
    }
    let daemon: any DaemonClient = client(stub)
    _ = try await daemon.writeFile(path, data: payload, baseVersion: .createOnly)
    _ = try await daemon.writeFile(path, data: payload, baseVersion: .match("version:1/#"))
    _ = try await daemon.deleteFile(path)
    let requests = stub.requests
    #expect(requests.map(\.method) == ["PUT", "PUT", "DELETE"])
    #expect(requests[0].target == route + "?ifAbsent=1")
    #expect(
      URLComponents(url: requests[1].url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value
        == "version:1/#")
    #expect(requests[0].body == payload)
    #expect(requests[0].header("Content-Type") == "application/octet-stream")
    #expect(requests.allSatisfy { $0.header("X-DDL-Workspace-Id") == "workspace-test" })
  }

  @Test func rejectsUnverifiedWritesUnsafePathsAndOversizedUploadsBeforeSending() async {
    let stub = Stub { _ in .json("{}") }
    await #expect(throws: DaemonClientError.self) {
      try await client(stub, workspace: nil).writeFile(
        path, data: payload, baseVersion: .createOnly)
    }
    await #expect(throws: DaemonClientError.self) {
      try await client(stub).writeFile(path, data: payload, baseVersion: .unconditional)
    }
    await #expect(throws: DaemonClientError.self) {
      try await client(stub).readFile("Assets/../secret.bin")
    }
    await #expect(throws: DaemonClientError.self) {
      try await client(stub).writeFile(
        path, data: Data(count: DaemonProtocol.attachmentMaxBytes + 1), baseVersion: .createOnly)
    }
    #expect(stub.requests.isEmpty)
  }

  @Test func rejectsWrongFileAndOversizedResponseMetadata() async {
    let wrong = headers(path: "Assets/different.bin")
    let data = payload
    let stub = Stub { _ in .respond(status: 200, headers: wrong, body: data) }
    await #expect(throws: DaemonClientError.self) { try await client(stub).readFile(path) }
    let oversized = headers(size: DaemonProtocol.attachmentMaxBytes + 1)
    stub.setHandler { _ in .respond(status: 200, headers: oversized, body: Data()) }
    await #expect(throws: DaemonClientError.self) { try await client(stub).readFile(path) }
  }
  @Test func boundedArtifactCancelsOversizedStreamWithoutContentLength() async throws {
    let data = payload
    let stub = Stub { _ in
      .respond(status: 200, headers: ["Content-Type": "application/octet-stream"], body: data)
    }
    let daemon: any DaemonClient = client(stub)
    await #expect(throws: DaemonClientError.self) {
      try await daemon.artifact(threadId: "thr_test", artifactId: "art_test", maxBytes: 6)
    }
    let accepted = try await daemon.artifact(
      threadId: "thr_test", artifactId: "art_test", maxBytes: 7)
    #expect(accepted.data == payload)
    let count = stub.requests.count
    await #expect(throws: DaemonClientError.self) {
      try await daemon.artifact(threadId: "thr_test", artifactId: "art_test", maxBytes: 0)
    }
    #expect(stub.requests.count == count)
  }

  @Test func boundedNoteChecksDecodedUTF8AndEncodedStreamWithoutTrustingLength() async throws {
    let note = NoteResponse(path: "Escaped.md", content: "\u{0}🌿", version: "v1", mtime: 0)
    let stub = Stub { _ in .json(200, value: note) }
    let received = try await client(stub).readNote(note.path, maxBytes: 5)
    #expect(received.content == note.content)
    await #expect(throws: DaemonClientError.self) {
      try await client(stub).readNote(note.path, maxBytes: 4)
    }
    await #expect(throws: DaemonClientError.self) {
      try await client(stub).readNote("Wrong.md", maxBytes: 5)
    }
    stub.setHandler { _ in
      .respond(status: 200, headers: [:], body: Data(repeating: 32, count: 5000))
    }
    await #expect(throws: DaemonClientError.self) {
      try await client(stub).readNote(note.path, maxBytes: 5)
    }
  }

}
