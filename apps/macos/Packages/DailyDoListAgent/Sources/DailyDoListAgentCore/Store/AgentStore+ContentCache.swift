import DailyDoListClient
import DailyDoListModels
import Foundation

extension AgentStore {
  public var hasContentCache: Bool { contentCache != nil }
  public var canFetchContent: Bool {
    if contentCache == nil { return true }
    if case .connected = connectionState { return true }
    return false
  }
  public var cachedContentReadOnly: Bool {
    contentCache != nil && (!canFetchContent || !contentAuthorityReady)
  }

  /// Offline cold launch. This does not call the daemon or mark any conversation as read.
  /// A live event/refresh that arrives during hydration wins over the disk snapshot.
  public func hydrateCachedContent() async {
    guard let contentCache, !cacheHydrated, eventSeq == 0 else { return }
    let mark = eventSeq
    let authority = mutationAuthorityGeneration
    await refreshPendingMutations()
    do {
      let saved = try await contentCache.inbox()
      guard mark == eventSeq, authority == mutationAuthorityGeneration, !contentAuthorityReady
      else { return }
      cacheHydrated = true
      guard let saved else { return }
      mutate {
        $0.status = saved.value.status
        $0.recordsByNote = saved.value.recordsByNote
        $0.threads = Dictionary(
          saved.value.threads.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        $0.approvals = Dictionary(
          saved.value.approvals.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        $0.routines = saved.value.routines
        return [.status, .records, .threads, .approvals, .routines]
      }
      approvalsFetchedAt = saved.value.approvalsFetchedAt
      routineTemplates = saved.value.routineTemplates
      routinesLoaded = true
      cachedInboxAt = saved.metadata.fetchedAt
      cacheAvailability[.inbox] = .available(saved.metadata)
    } catch { report(error, title: "Couldn't load the offline Inbox") }
  }

  func hydrateCachedThread(_ id: String) async {
    guard let contentCache else { return }
    let mark = eventSeq
    let authority = mutationAuthorityGeneration
    do {
      guard let saved = try await contentCache.thread(id), state.loadedThreads[id] == nil,
        mark == eventSeq, authority == mutationAuthorityGeneration
      else { return }
      var response = saved.value
      if contentAuthorityReady { response.approvals = [] }
      mutate { $0.applyThreadResponse(response, inFlight: []) }
      cachedThreadIDs.insert(id)
      cacheAvailability[.thread(id)] = .available(saved.metadata)
      restorePendingMessages(threadID: id)
    } catch { report(error, title: "Couldn't load the offline conversation") }
  }

  public func refreshCacheAvailability(_ resource: AgentCacheResource) async {
    guard let contentCache else { return }
    do { cacheAvailability[resource] = try await contentCache.availability(resource) } catch {
      report(error, title: "Couldn't read download state")
    }
  }

  public func setContentPinned(_ resource: AgentCacheResource, pinned: Bool) async {
    guard let contentCache else { return }
    do {
      try await contentCache.setPinned(resource, pinned: pinned)
      await refreshCacheAvailability(resource)
    } catch { report(error, title: "Couldn't change the offline download") }
  }

  func changedCacheThreads(_ event: ServerEvent) -> Set<String> {
    switch event {
    case .threadMessage(let event): [event.threadId]
    case .threadDelta(let event): [event.threadId]
    case .threadUpsert(let thread): [thread.id]
    case .approvalUpsert(let approval): Set(approval.threadId.map { [$0] } ?? [])
    default: []
    }
  }

  func contentDidChange(threadIDs: Set<String> = []) {
    guard contentCache != nil else { return }
    cacheStateRevision &+= 1
    cacheDirtyThreads.formUnion(threadIDs)
    guard cacheCheckpointTask == nil else { return }
    let delay = cacheCheckpointDelay
    cacheCheckpointTask = Task { [weak self] in
      do { try await Task.sleep(for: delay) } catch { return }
      guard let self else { return }
      self.cacheCheckpointTask = nil
      await self.flushContentCache()
    }
  }

  /// Coalesced snapshot checkpoint, also called by the phone before suspension. No network.
  public func flushContentCache() async {
    cacheCheckpointTask?.cancel()
    cacheCheckpointTask = nil
    if let task = cacheFlushTask {
      await task.value
      return
    }
    guard contentCache != nil, cacheStateRevision != cachePersistedRevision else { return }
    let task = Task { [weak self] in
      guard let self else { return }
      await self.performContentFlush()
    }
    cacheFlushTask = task
    await task.value
    cacheFlushTask = nil
  }

  private func performContentFlush() async {
    guard let contentCache else { return }
    // Bounded under continuous streaming; remaining changes receive another coalesced pass.
    for _ in 0..<3 {
      let revision = cacheStateRevision
      if revision == cachePersistedRevision || Task.isCancelled { return }
      let inbox = AgentInboxSnapshot(
        status: state.status, threads: Array(state.threads.values),
        approvals: Array(state.approvals.values),
        recordsByNote: state.recordsByNote, routines: state.routines,
        routineTemplates: routineTemplates,
        approvalsFetchedAt: approvalsFetchedAt)
      let threadIDs = cacheDirtyThreads
      do {
        let ticket = try await contentCache.begin(.inbox)
        guard !Task.isCancelled else { return }
        if revision != cacheStateRevision { continue }
        let metadata = try await contentCache.storeInbox(inbox, ticket: ticket)
        cachedInboxAt = metadata.fetchedAt
        cacheAvailability[.inbox] = .available(metadata)
        for id in threadIDs.sorted() {
          guard !Task.isCancelled else { return }
          if revision != cacheStateRevision { break }
          guard var thread = state.loadedThreads[id], !cachedThreadIDs.contains(id) else {
            continue
          }
          // Optimistic messages belong to the durable mutation journal, not server cache.
          if let localIDs = state.optimisticMessages[id], !localIDs.isEmpty {
            let ids = Set(localIDs)
            thread.messages.removeAll { ids.contains($0.id) }
          }
          let response = ThreadResponse(
            thread: thread,
            approvals: state.approvals.values.filter { $0.threadId == id })
          let ticket = try await contentCache.begin(.thread(id))
          guard !Task.isCancelled else { return }
          if revision != cacheStateRevision { break }
          let saved = try await contentCache.storeThread(response, ticket: ticket)
          cacheAvailability[.thread(id)] = .available(saved)
        }
        if revision == cacheStateRevision {
          cachePersistedRevision = revision
          cacheDirtyThreads.subtract(threadIDs)
          return
        }
      } catch {
        if !Task.isCancelled { report(error, title: "Couldn't save the offline agent copy") }
        return
      }
    }
    contentDidChange()
  }
}
