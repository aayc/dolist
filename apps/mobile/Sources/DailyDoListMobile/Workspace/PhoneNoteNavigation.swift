import DailyDoListDomain
import DailyDoListMobileKit
import SwiftUI

struct PhoneNoteNavigation: View {
  @Bindable var workspace: PhoneWorkspace
  @State private var showCalendar = false
  @State private var date = Date()

  var body: some View {
    HStack {
      Button("Back", systemImage: "chevron.left") { Task { await workspace.goBack() } }.disabled(
        !workspace.tabs.canGoBack)
      Button("Forward", systemImage: "chevron.right") { Task { await workspace.goForward() } }
        .disabled(!workspace.tabs.canGoForward)
      Menu("Open notes", systemImage: "square.on.square") {
        ForEach(workspace.tabs.tabs, id: \.self) { path in
          Button(path) { Task { await workspace.open(path) } }
        }
        Divider()
        if let path = workspace.active?.note.path {
          Button("Close current note", systemImage: "xmark") {
            Task { await workspace.closeNote(path) }
          }
        }
        Button("Reopen closed note", systemImage: "arrow.uturn.backward") {
          Task { await workspace.reopenNote() }
        }
        .disabled(!workspace.tabs.canReopenClosedTab)
      }
      Spacer()
      Menu("Daily notes", systemImage: "calendar") {
        Button("Today") { Task { await workspace.openToday() } }
        Button("Tomorrow") {
          Task {
            await workspace.openDaily(LocalDate(date: Date(), timeZone: .current).adding(days: 1))
          }
        }
        Button("Choose date…") { showCalendar = true }
        Button("Previous daily note") { Task { await workspace.openAdjacentDaily(.previous) } }
        Button("Next daily note") { Task { await workspace.openAdjacentDaily(.next) } }
        Divider()
        Button("This week") { Task { await workspace.openWeekly() } }
      }
    }
    .labelStyle(.iconOnly).buttonStyle(.borderless).padding(.horizontal).frame(minHeight: 44)
    .background(.bar)
    .sheet(isPresented: $showCalendar) {
      NavigationStack {
        DatePicker("Note date", selection: $date, displayedComponents: .date).datePickerStyle(
          .graphical
        ).padding()
          .navigationTitle("Open a daily note")
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Cancel") { showCalendar = false }
            }
            ToolbarItem(placement: .confirmationAction) {
              Button("Open") {
                showCalendar = false
                Task { await workspace.openDaily(LocalDate(date: date, timeZone: .current)) }
              }
            }
          }
      }.presentationDetents([.medium, .large])
    }
  }
}
