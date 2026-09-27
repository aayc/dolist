import SwiftUI

struct PhonePaletteView: View {
  @State private var model: PhonePaletteModel
  @Environment(\.dismiss) private var dismiss

  init(mode: PhonePaletteMode, controller: PhoneCommandController) {
    _model = State(initialValue: PhonePaletteModel(mode: mode, controller: controller))
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 8) {
        Picker("Search", selection: $model.mode) {
          ForEach(PhonePaletteMode.allCases) { Text($0.rawValue).tag($0) }
        }.pickerStyle(.segmented).padding(.horizontal)
        PhonePaletteSearchField(
          text: $model.query,
          placeholder: model.mode == .commands
            ? "Type a command"
            : model.mode == .contents ? "Search note text" : "Find a note by name or path",
          key: handleKey
        ).frame(height: 44).padding(.horizontal)
        HStack {
          Text(model.coverage).font(.caption).foregroundStyle(.secondary)
          Spacer()
          if model.searching { ProgressView().controlSize(.small) }
        }.padding(.horizontal)
        ScrollViewReader { scroll in
          List {
            ForEach(Array(model.items.enumerated()), id: \.element.id) { index, item in
              Button {
                model.activate(item)
              } label: {
                HStack(alignment: .firstTextBaseline) {
                  VStack(alignment: .leading, spacing: 4) {
                    highlighted(item.title, offsets: item.highlights).lineLimit(2)
                    if let detail = item.detail {
                      Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                    }
                  }
                  Spacer(minLength: 4)
                  if let shortcut = item.shortcut {
                    Text(shortcut).font(.caption.monospaced()).foregroundStyle(.secondary)
                  }
                }.foregroundStyle(.primary).frame(maxWidth: .infinity, alignment: .leading)
              }
              .id(item.id)
              .listRowBackground(
                index == model.selectedIndex ? Color.accentColor.opacity(0.14) : Color.clear
              )
              .accessibilityAddTraits(index == model.selectedIndex ? .isSelected : [])
              .accessibilityIdentifier("palette.result.\(index)")
              .contextMenu {
                if case .note = item.target {
                  Button("Open in new tab") { model.activate(item, newTab: true) }
                }
              }
            }
            if model.items.isEmpty && !model.searching {
              Text("No matches").foregroundStyle(.secondary)
            }
            if model.canCreate {
              Button(
                "Create note named \(model.query.trimmingCharacters(in: .whitespacesAndNewlines))",
                systemImage: "doc.badge.plus"
              ) {
                model.controller.createFromQuery(model.query)
              }.accessibilityIdentifier("palette.create")
            }
          }.listStyle(.plain)
            .onChange(of: model.selectedIndex) { _, _ in
              if let selected = model.selected { scroll.scrollTo(selected.id, anchor: .center) }
            }
        }
      }
      .navigationTitle(model.mode == .commands ? "Commands" : "Quick open")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
    }
    .task { await model.refresh() }
    .task(
      id: SearchKey(mode: model.mode, query: model.query, online: model.controller.workspace.online)
    ) {
      await model.searchContents()
    }
    .presentationDetents([.large])
  }

  private struct SearchKey: Hashable {
    let mode: PhonePaletteMode
    let query: String
    let online: Bool
  }
  private func handleKey(_ key: PhonePaletteKey) {
    switch key {
    case .move(let delta): model.move(delta)
    case .cancel: dismiss()
    case .submit(let newTab, let create):
      if create && model.canCreate {
        model.controller.createFromQuery(model.query)
      } else if let selected = model.selected {
        model.activate(selected, newTab: newTab)
      }
    }
  }

  private func highlighted(_ string: String, offsets: [Int]) -> Text {
    let highlights = Set(offsets)
    var offset = 0
    return string.reduce(Text("")) { text, character in
      let value = String(character)
      let range = offset..<(offset + value.utf16.count)
      offset += value.utf16.count
      return text + (range.contains(where: highlights.contains) ? Text(value).bold() : Text(value))
    }
  }
}
