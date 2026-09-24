import DailyDoListDomain
import SwiftUI

/// Open-note tabs (Obsidian-style): click to switch, × or ⌘W to close, dot = unsaved.
struct TabStrip: View {
  let workspace: Workspace

  var body: some View {
    HStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 2) {
            ForEach(workspace.tabs.tabs, id: \.self) { path in
              TabItem(
                workspace: workspace, path: path, isActive: workspace.tabs.active == path,
                saveState: workspace.notes.saveStates[path])
              .id(path)
            }
          }
          .padding(.horizontal, 6)
        }
        .onChange(of: workspace.tabs.active) { _, active in
          if let active { withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(active) } }
        }
      }
      IconButton(systemImage: "plus", help: "New note (⌘N)") {
        Task { await workspace.createNote() }
      }
      .padding(.trailing, 6)
    }
    .frame(height: Theme.tabBarHeight)
    .background(Theme.secondaryBackground)
  }
}

private struct TabItem: View {
  let workspace: Workspace
  let path: String
  let isActive: Bool
  let saveState: SaveState?
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 6) {
      Text(VaultPath.stem(path))
        .font(.system(size: 12, weight: isActive ? .medium : .regular))
        .foregroundStyle(isActive ? Theme.text : Theme.mutedText)
        .lineLimit(1)
        .truncationMode(.middle)
      ZStack {
        if hovering || isActive {
          Button {
            workspace.closeTab(path)
          } label: {
            Image(systemName: "xmark")
              .font(.system(size: 9, weight: .bold))
              .foregroundStyle(Theme.faintText)
              .frame(width: 14, height: 14)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .help("Close tab (⌘W)")
        } else if saveState?.hasUnsavedChanges == true {
          Circle().fill(saveState == .conflict ? Theme.warning : Theme.mutedText).frame(width: 6, height: 6)
        }
      }
      .frame(width: 14)
    }
    .padding(.leading, 12)
    .padding(.trailing, 6)
    .frame(minWidth: 90, maxWidth: 200, minHeight: 26)
    .background(
      RoundedRectangle(cornerRadius: 6)
        .fill(isActive ? Theme.background : (hovering ? Theme.hover : .clear)))
    .contentShape(Rectangle())
    .onTapGesture { workspace.activateTab(path) }
    .onHover { hovering = $0 }
    .help(path)
    .contextMenu {
      Button("Close Tab") { workspace.closeTab(path) }
      Button("Close Other Tabs") { workspace.closeOtherTabs(except: path) }
      Divider()
      Button("Copy Path") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path, forType: .string)
      }
      if workspace.localVaultURL != nil {
        Button("Reveal in Finder") { workspace.revealInFinder(path) }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(isActive ? [.isSelected, .isButton] : .isButton)
  }
}
