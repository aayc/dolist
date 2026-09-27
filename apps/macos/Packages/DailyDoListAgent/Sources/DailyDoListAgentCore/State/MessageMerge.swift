import DailyDoListModels

/// How two versions of the same thread message combine. Newer copies normally win, but a copy
/// that is *behind* (delivered late or replayed) never undoes progress.
enum MessageMerge {
  /// - Parameter existingIsPlaceholder: `existing` was created locally from deltas that arrived
  ///   before the message itself, so its text is what followed the message's initial text.
  static func merge(
    existing: ThreadMessage, incoming: ThreadMessage, existingIsPlaceholder: Bool = false
  ) -> ThreadMessage {
    switch (existing, incoming) {
    case (.text(let old), .text(var new)):
      // The final text is authoritative.
      guard new.streaming == true else { return incoming }
      // A stale streaming copy of a message that already finished.
      if old.streaming != true { return existing }
      if new.text.hasPrefix(old.text) { return incoming }
      // A stale copy of the start of the stream: keep the text streamed since.
      if old.text.hasPrefix(new.text) {
        new.text = old.text
        return .text(new)
      }
      if existingIsPlaceholder {
        new.text += old.text
        return .text(new)
      }
      return incoming
    case (.toolCall(let old), .toolCall(let new)):
      // A finished call never goes back to running.
      if old.status != .running && new.status == .running { return existing }
      return incoming
    default:
      return incoming
    }
  }
}
