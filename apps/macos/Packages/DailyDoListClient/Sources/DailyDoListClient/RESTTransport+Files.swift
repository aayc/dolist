import DailyDoListModels
import Foundation

extension RESTTransport {
  func vaultFile(_ path: String) async throws(DaemonClientError) -> VaultFilePayload {
    let request = try makeRequest(
      .get, path, body: nil, accept: "*/*", timeout: artifactTimeout, attribute: false)
    let (data, response) = try await boundedFileExchange(request)
    try check(response, data, conflict: .none, credential: .bearer)
    guard let encoded = response.value(forHTTPHeaderField: "X-DDL-File-Path"),
      let filePath = encoded.removingPercentEncoding,
      let version = response.value(forHTTPHeaderField: "X-DDL-File-Version"), !version.isEmpty,
      let time = response.value(forHTTPHeaderField: "X-DDL-File-Mtime"), let mtime = Double(time),
      mtime.isFinite, mtime >= 0,
      let length = response.value(forHTTPHeaderField: "Content-Length"), Int(length) == data.count
    else { throw .decoding("Invalid attachment response metadata.") }
    guard try RequestGuards.fileRoute(filePath) == path else {
      throw .decoding("The attachment response names a different file.")
    }
    let mime =
      response.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first.map(
        String.init)
      ?? "application/octet-stream"
    return VaultFilePayload(
      data: data,
      metadata: VaultFileMetadata(
        path: filePath, version: version, mtime: mtime, size: data.count, mimeType: mime))
  }

  func uploadVaultFile(_ path: String, data: Data) async throws(DaemonClientError)
    -> VaultFileMetadata
  {
    guard data.count <= DaemonProtocol.attachmentMaxBytes else { throw Self.attachmentTooLarge }
    var request = try makeRequest(
      .put, path, body: data, accept: "application/json", timeout: artifactTimeout, attribute: true)
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    let (payload, response) = try await boundedFileExchange(request)
    try check(response, payload, conflict: .none, credential: .bearer)
    do { return try JSONDecoder.daemon.decode(VaultFileMetadata.self, from: payload) } catch {
      throw .decoding(error, type: VaultFileMetadata.self)
    }
  }

  func boundedFileExchange(_ request: URLRequest, maxBytes: Int = DaemonProtocol.attachmentMaxBytes)
    async throws(DaemonClientError) -> (Data, HTTPURLResponse)
  {
    guard maxBytes > 0 else { throw .invalidRequest("The download limit must be positive.") }
    do {
      let (stream, response) = try await session.bytes(for: request)
      defer { stream.task.cancel() }
      guard let response = response as? HTTPURLResponse else {
        throw DaemonClientError.unreachable("The host did not answer with HTTP.")
      }
      let limit = maxBytes
      if response.expectedContentLength > limit { throw Self.downloadTooLarge(limit) }
      var data = Data()
      if response.expectedContentLength > 0 {
        data.reserveCapacity(Int(response.expectedContentLength))
      }
      for try await byte in stream {
        guard data.count < limit else { throw Self.downloadTooLarge(limit) }
        data.append(byte)
      }
      return (data, response)
    } catch let error as DaemonClientError { throw error } catch {
      throw Self.transportError(error)
    }
  }

  static func downloadTooLarge(_ maxBytes: Int) -> DaemonClientError {
    .http(
      status: 413,
      body: ApiErrorBody(
        error: .payloadTooLarge, message: "Download exceeds the configured \(maxBytes)-byte limit.")
    )
  }

  private static var attachmentTooLarge: DaemonClientError {
    .http(
      status: 413,
      body: ApiErrorBody(error: .payloadTooLarge, message: "Attachments are limited to 5 MiB."))
  }
}
