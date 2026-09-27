import DailyDoListMobileDrawing
import SwiftUI

struct PhoneDrawingView: View {
  let session: DrawingSession
  @State private var source = false
  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text(session.saveLabel).font(.caption).foregroundStyle(
          session.error == nil ? Color.secondary : Color.red)
        Spacer()
        Button("Drawing source", systemImage: "doc.text.magnifyingglass") { source = true }
          .labelStyle(.iconOnly)
      }.padding(.horizontal).frame(minHeight: 32).background(.bar)
      if !session.drawing.canEdit {
        Text(
          "The original file is preserved. Repair it on the host or export a recovery copy before editing."
        )
        .font(.footnote).padding()
      }
      MobileDrawingView(controller: session.controller)
    }
    .sheet(isPresented: $source) {
      NavigationStack {
        ScrollView {
          Text(session.drawing.content).font(.system(.caption, design: .monospaced)).textSelection(
            .enabled
          ).padding()
        }
        .navigationTitle("Original file")
        .toolbar { Button("Done") { source = false } }
      }
    }
  }
}
