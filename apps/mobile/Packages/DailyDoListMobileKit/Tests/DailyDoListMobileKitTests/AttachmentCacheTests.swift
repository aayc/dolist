import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListMobileKit

struct AttachmentCacheTests {
  @Test func attachmentBytesRetainTheirExactPathVersionAndScopeAcrossRestart() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try WorkspaceContentCache(rootDirectory: fixture.directory, scope: fixture.scope)
    let path = "Attachments/Synthetic.png"
    let payload = VaultFilePayload(
      data: Data([0, 255, 127]),
      metadata: .init(
        path: path, version: "version-one", mtime: 1, size: 3, mimeType: "image/png"))
    let ticket = try await cache.beginAttachmentFetch(path)
    _ = try await cache.storeAttachment(payload, fetch: ticket)
    let reopened = try WorkspaceContentCache(rootDirectory: fixture.directory, scope: fixture.scope)
    let saved = try #require(await reopened.attachment(path))
    #expect(saved.data == payload.data)
    #expect(saved.metadata == payload.metadata)
    let old = try await cache.beginAttachmentFetch(path)
    try await cache.remove(.attachment(path: path))
    await #expect(throws: WorkspaceContentCacheError.staleFetch) {
      try await reopened.storeAttachment(payload, fetch: old)
    }
    let wrong = try await cache.beginAttachmentFetch("Attachments/Other.png")
    await #expect(throws: WorkspaceContentCacheError.invalidContent) {
      try await cache.storeAttachment(payload, fetch: wrong)
    }
    await #expect(throws: WorkspaceContentCacheError.invalidContent) {
      try await cache.beginAttachmentFetch("../Outside.png")
    }
  }
}
