import DailyDoListClient
import DailyDoListEditorCore
import DailyDoListModels
import DailyDoListWorkspaceCore
import Foundation

extension PhoneWorkspace {
  func configureAnnotations(_ session: NoteSession) {
    session.editor.onBadgeTap = { [weak self] badge in
      guard let self else { return }
      if let chip = self.chipBoard.chip(badge.id) {
        self.openAnnotationThread(chip.threadToOpen, turn: chip.turnId)
      } else {
        self.openAnnotationThread(badge.threadId)
      }
    }
    session.editor.onAgentMarkerTap = { [weak self] in self?.openAnnotationThread($0) }
    session.editor.onUserEdit = { [weak self, weak session] in
      if let session { self?.reportPresence(session, edited: true) }
    }
    refreshAnnotations(session)
  }

  func openAnnotationThread(_ id: String?, turn: String? = nil) {
    if let id {
      routedThread = PhoneThreadDestination(id: id)
    } else {
      if let turn { agent?.focusOrchestratorMessage(turn) }
      routedThread = PhoneThreadDestination(id: OrchestratorThread.id)
    }
  }

  func refreshAnnotations(_ session: NoteSession) {
    let records = agent?.records(for: session.note.path) ?? []
    let badges = BadgeBuilder.badges(for: records, in: session.editor.text)
    var placed = placedChips[session.note.path] ?? []
    let chips = ChipBuilder.badges(
      for: chipBoard.chips(for: session.note.path),
      in: session.editor.text, current: session.editor.badges, placed: &placed,
      taken: Set(badges.map(\.line)))
    placedChips[session.note.path] = placed
    session.editor.setBadges(badges + chips)
  }

  func scheduleAnnotations() {
    guard annotationUpdate == nil else { return }
    annotationUpdate = Task { [weak self] in
      await Task.yield()
      guard let self, !Task.isCancelled else { return }
      self.annotationUpdate = nil
      for session in self.sessions.values { self.refreshAnnotations(session) }
    }
  }

  func receiveAnnotations(_ item: DaemonStreamItem) {
    if case .event(let event) = item {
      switch event {
      case .orchestratorActivity(let activity): applyActivity(activity)
      case .agentStatus(let status):
        if let activity = status.orchestrator { applyActivity(activity) }
      default: break
      }
      scheduleAnnotations()
    }
  }

  func applyActivity(_ activity: OrchestratorActivity) {
    if activity.phase.isWorking {
      workingActivity = activity
    } else if activity.phase == .idle, workingActivity?.turnId == activity.turnId {
      workingActivity = nil
    }
    let change = chipBoard.apply(activity)
    for id in change.noticed { expireChip(id, after: 60, noticedOnly: true) }
    for id in change.ended {
      expireChip(id, after: chipBoard.chip(id)?.outcome?.kind == .noAction ? 2.5 : 6)
    }
    scheduleAnnotations()
  }

  private func expireChip(_ id: String, after seconds: Double, noticedOnly: Bool = false) {
    chipTimers[id]?.cancel()
    chipTimers[id] = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
      guard let self, !Task.isCancelled else { return }
      self.chipTimers[id] = nil
      if noticedOnly, self.chipBoard.chip(id)?.phase != .noticed { return }
      _ = self.chipBoard.remove(id)
      self.scheduleAnnotations()
    }
  }

  func resetAnnotations() {
    for timer in chipTimers.values { timer.cancel() }
    chipTimers.removeAll()
    chipBoard = OrchestratorChipBoard()
    placedChips.removeAll()
    workingActivity = nil
    presenceTimer?.cancel()
    presenceTimer = nil
    pendingPresence = nil
    scheduleAnnotations()
  }

  func reportPresence(_ session: NoteSession, edited: Bool = false) {
    guard online, active === session, session.editor.input.isFirstResponder else { return }
    let position = (session.note.path, session.editor.selectedLine)
    guard edited || lastPresence?.0 != position.0 || lastPresence?.1 != position.1 else { return }
    pendingPresence = position
    if presenceTimer == nil {
      sendPresence()
      presenceTimer = Task { [weak self] in
        do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
        guard let self, !Task.isCancelled else { return }
        self.presenceTimer = nil
        self.sendPresence()
      }
    }
  }

  private func sendPresence() {
    guard online, let client, let pendingPresence else { return }
    self.pendingPresence = nil
    lastPresence = pendingPresence
    let epoch = generation
    Task { [weak self] in
      guard let self, self.generation == epoch, self.online else { return }
      await client.send(.editorActivity(notePath: pendingPresence.0, line: pendingPresence.1))
    }
  }
}
