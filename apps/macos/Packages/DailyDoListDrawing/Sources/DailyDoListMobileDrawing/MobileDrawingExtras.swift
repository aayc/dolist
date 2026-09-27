#if canImport(UIKit)
  import SwiftUI

  struct MobileDrawingExtras: View {
    let controller: MobileDrawingController
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var error: String?
    var body: some View {
      Form {
        Section("Embeddable URL card") {
          TextField("https://example.com", text: $address).keyboardType(.URL)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
          Button("Insert URL card") {
            do {
              try controller.editor.insertURLCard(address, at: controller.insertionPoint)
              dismiss()
            } catch { self.error = error.localizedDescription }
          }.disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          Text(
            "The card stores the link in the drawing. Use Open link to view its content; no page is loaded automatically."
          )
          .font(.footnote).foregroundStyle(.secondary)
          if let error { Text(error).foregroundStyle(.red) }
        }
      }.navigationTitle("Insert URL card")
    }
  }
#endif
