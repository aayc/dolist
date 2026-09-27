import DailyDoListMobileKit
import SwiftUI

/// The connection boundary is built before any vault UI so an unverified endpoint can never
/// receive recovered local drafts. Pairing is added with the workspace handshake.
struct ConnectionView: View {
  @State private var address = ""
  @State private var error: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Label("Your notes, with you", systemImage: "checklist")
            .font(.title2.weight(.semibold))
            .padding(.vertical, 8)
          Text("Connect to the Daily Do List host that keeps your notes and runs your agent.")
            .foregroundStyle(.secondary)
        }
        Section("Host address") {
          TextField("https://your-private-host", text: $address)
            .textContentType(.URL)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("connection.address")
          Button("Check address") {
            do {
              _ = try ConnectionOrigin(address)
              error = "Address is valid. Pairing setup is in development."
            } catch {
              self.error = error.localizedDescription
            }
          }
          .accessibilityIdentifier("connection.validate")
        }
        if let error {
          Section { Text(error).accessibilityIdentifier("connection.message") }
        }
        Section {
          Text("On your Mac or always-on host, open Settings → Devices to create a pairing code.")
            .foregroundStyle(.secondary)
        }
      }
      .navigationTitle("Daily Do List")
    }
  }
}
