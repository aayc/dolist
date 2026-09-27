import DailyDoListClient
import Foundation

extension ConnectionChannel {
  public static func native(
    origin: ConnectionOrigin, token: String, expectedWorkspaceID: String?
  ) -> ConnectionChannel {
    let session = PrivateConnectionSession().makeSession()
    let client = HTTPDaemonClient(
      endpoint: DaemonEndpoint(baseURL: origin.url, token: token, forceHeaderAuthentication: true),
      session: session,
      clientId: "ios_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(),
      clientVersion:
        "ios/\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")",
      expectedWorkspaceId: expectedWorkspaceID)
    return ConnectionChannel(client: client) { session.invalidateAndCancel() }
  }
}
