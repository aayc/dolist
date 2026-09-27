import AVFoundation
import DailyDoListMobileKit
import SwiftUI
import VisionKit

struct ConnectionView: View {
  let pairing: PairingService
  var existingProfile: ConnectionProfile? = nil
  let onPaired: (ConnectionProfile) async -> Void
  @State private var address = ""
  @State private var code = ""
  @State private var name = "My iPhone"
  @State private var profileID = UUID()
  @State private var error: String?
  @State private var busy = false
  @State private var scanning = false
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Label("Your notes, with you", systemImage: "checklist")
            .font(.title2.weight(.semibold)).padding(.vertical, 8)
          Text("Connect to the Daily Do List host that keeps your notes and runs your agent.")
            .foregroundStyle(.secondary)
        }
        Section("Host address") {
          TextField("https://your-private-host", text: $address)
            .textContentType(.URL).keyboardType(.URL)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .accessibilityIdentifier("connection.address").disabled(existingProfile != nil)
          Button("Scan QR code", systemImage: "qrcode.viewfinder") { Task { await scan() } }
        }
        Section("Pair this iPhone") {
          TextField("Pairing code", text: $code)
            .textContentType(.oneTimeCode).textInputAutocapitalization(.characters)
            .autocorrectionDisabled().accessibilityIdentifier("connection.code")
          TextField("Device name", text: $name).accessibilityIdentifier("connection.name")
          Button {
            Task { await pair() }
          } label: {
            HStack {
              Text(busy ? "Pairing…" : "Pair iPhone")
              Spacer()
              if busy { ProgressView() }
            }
          }
          .onAppear {
            if let existingProfile {
              address = existingProfile.origin.url.absoluteString
              profileID = existingProfile.id
            }
          }
          .disabled(busy).accessibilityIdentifier("connection.validate")
        }
        if let error {
          Section {
            Text(error).foregroundStyle(.red).accessibilityIdentifier("connection.message")
          }
        }
        Section {
          Text(
            "On your Mac or always-on host, open Settings → Devices to create a pairing code. Review the host address before pairing."
          )
          .foregroundStyle(.secondary)
        }
      }
      .onAppear {
        if let existingProfile {
          address = existingProfile.origin.url.absoluteString
          profileID = existingProfile.id
        }
      }
      .disabled(busy)
      .navigationTitle("Connect")
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
      .sheet(isPresented: $scanning) {
        NavigationStack {
          PairingScanner { raw in
            scanning = false
            do {
              let payload = try PairingCodePayload(raw)
              address = payload.origin.url.absoluteString
              if let code = payload.code { self.code = code }
              error = nil
            } catch { self.error = error.localizedDescription }
          } failed: { message in
            scanning = false
            error = message
          }
          .navigationTitle("Scan pairing code")
          .toolbar { Button("Cancel") { scanning = false } }
        }
      }
    }
  }

  private func pair() async {
    busy = true
    defer { busy = false }
    do {
      let origin = try ConnectionOrigin(address)
      let profile =
        existingProfile
        ?? ConnectionProfile(id: profileID, name: origin.url.host() ?? "My host", origin: origin)
      let paired = try await pairing.pair(profile: profile, code: code, deviceName: name)
      error = nil
      await onPaired(paired)
      dismiss()
    } catch { self.error = error.localizedDescription }
  }

  private func scan() async {
    guard DataScannerViewController.isSupported else {
      error = "This device cannot scan QR codes. Enter the host address and pairing code instead."
      return
    }
    guard await AVCaptureDevice.requestAccess(for: .video), DataScannerViewController.isAvailable
    else {
      error = "Allow camera access in iPhone Settings to scan, or enter the address and code here."
      return
    }
    scanning = true
  }
}
