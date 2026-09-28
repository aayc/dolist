import DailyDoListModels
import Foundation

extension HTTPDaemonClient {
  /// Bulk offline downloads bound both encoded JSON and decoded markdown before publication.
  /// JSON escaping can expand one UTF-8 byte to six bytes; the envelope remains separately capped.
  public func readNote(_ path: String, maxBytes: Int) async throws -> NoteResponse {
    guard maxBytes > 0, maxBytes <= 16 * 1_024 * 1_024 else {
      throw DaemonClientError.invalidRequest("The note download limit is invalid.")
    }
    let payload = try await transport.bytes(
      try RequestGuards.noteRoute(path), maxBytes: maxBytes * 6 + 4_096)
    let note = try JSONDecoder.daemon.decode(NoteResponse.self, from: payload.data)
    guard note.path == path else {
      throw DaemonClientError.invalidRequest("The host returned a different note.")
    }
    guard note.content.utf8.count <= maxBytes else {
      throw RESTTransport.downloadTooLarge(maxBytes)
    }
    return note
  }
}
