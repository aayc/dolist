import DailyDoListModels
import Foundation

extension HTTPDaemonClient {
  public func artifact(threadId: String, artifactId: String, maxBytes: Int) async throws
    -> ArtifactPayload
  {
    let thread = try RequestGuards.runtimeID(threadId, "threadId")
    let artifact = try RequestGuards.runtimeID(artifactId, "artifactId")
    return try await transport.bytes(
      APIRoute.artifact(threadId: thread, artifactId: artifact), maxBytes: maxBytes)
  }

  public func readFile(_ path: String) async throws -> VaultFilePayload {
    try await transport.vaultFile(try RequestGuards.fileRoute(path))
  }

  public func writeFile(_ path: String, data: Data, baseVersion: BaseVersion) async throws
    -> VaultFileMetadata
  {
    guard expectedWorkspaceId != nil else {
      throw DaemonClientError.invalidRequest("Attachment uploads require a verified workspace.")
    }
    let route = try RequestGuards.fileRoute(path)
    let query: String
    switch baseVersion {
    case .createOnly: query = "?ifAbsent=1"
    case .match(let version):
      guard !version.isEmpty, version.count <= 256 else {
        throw DaemonClientError.invalidRequest("Invalid attachment version.")
      }
      var parts = URLComponents()
      parts.queryItems = [URLQueryItem(name: "ifMatch", value: version)]
      query = "?" + (parts.percentEncodedQuery ?? "")
    case .unconditional:
      throw DaemonClientError.invalidRequest("Attachment uploads must create or match a version.")
    }
    return try await transport.uploadVaultFile(route + query, data: data)
  }

  public func deleteFile(_ path: String) async throws -> TrashResponse {
    guard expectedWorkspaceId != nil else {
      throw DaemonClientError.invalidRequest("Attachment deletion requires a verified workspace.")
    }
    return try await transport.json(.delete, try RequestGuards.fileRoute(path))
  }
}
