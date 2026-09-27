#if DEBUG
  import DailyDoListMobileEditor
  import SwiftUI

  /// A synthetic, in-memory input laboratory. It never discovers or connects to a real vault.
  struct EditorSpikeView: View {
    @State private var controller = MobileMarkdownController()
    @State private var preview = true
    @State private var showSource = false
    var body: some View {
      NavigationStack {
        MobileMarkdownView(controller: controller)
          .navigationTitle("Editor check")
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
              Button(preview ? "Source" : "Preview") {
                preview.toggle()
                var config = controller.configuration
                config.livePreview = preview
                controller.updateConfiguration(config)
              }
            }
            ToolbarItemGroup(placement: .bottomBar) {
              Button("Task", systemImage: "checkmark.square") { controller.run(.checklist) }
              Button("Bold", systemImage: "bold") { controller.run(.bold) }
              Button("Indent", systemImage: "increase.indent") { controller.run(.indent) }
              Button("Undo", systemImage: "arrow.uturn.backward") { controller.run(.undo) }
              Button("Inspect", systemImage: "doc.text.magnifyingglass") { showSource = true }
            }
          }
          .sheet(isPresented: $showSource) {
            NavigationStack {
              ScrollView {
                Text(controller.text).font(.system(.body, design: .monospaced)).textSelection(
                  .enabled
                ).padding()
              }
              .navigationTitle("Markdown source")
              .toolbar { Button("Done") { showSource = false } }
            }
          }
          .onAppear {
            if controller.text.isEmpty {
              controller.load(
                "# A calmer day\n\nWrite freely. **Your words stay yours.**\n\n- [ ] Plan a synthetic weekend walk\n- [x] Read the trail guide\n\n## Notes\n\nTry emoji 🌿, accents café, and lists.\n"
              )
            }
          }
      }
    }
  }
#endif
