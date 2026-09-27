# Native living-list presentation

The phone keeps prose anchors in the same `BadgeStore` as macOS. A thread's `highlightsLine`
annotation draws a soft accent band and left bar behind each wrapped fragment. Mapping a source
edit moves its anchor; removing the source removes the band. Idle/ignored/fading badges and
replaced content blocks draw no prose band. The renderer preserves each text fragment's geometry
around drawing exclusion paths and draws before TextKit selection backgrounds.

## Editor composition hooks

`MobileProseHighlights.swift` is independent of the editor's active layout work. Add this callback
to `MobileLayoutManager`, then invoke it before `super.drawBackground`:

```swift
@MainActor var proseHighlights: ((NSRange, CGPoint) -> Void)?

override func drawBackground(forGlyphRange glyphs: NSRange, at origin: CGPoint) {
  nonisolated(unsafe) let manager = self
  MainActor.assumeIsolated { manager.proseHighlights?(glyphs, origin) }
  super.drawBackground(forGlyphRange: glyphs, at: origin)
}
```

In `MobileMarkdownController.init`, set the callback without retaining the controller:

```swift
(input.layoutManager as? MobileLayoutManager)?.proseHighlights = { [weak self] in
  guard let self else { return }
  self.drawProseHighlights(forGlyphRange: $0, at: $1) {
    self.content.hiddenRange(at: $0) != nil
  }
}
```

When badges change, call `owner?.input.setNeedsDisplay()` in the annotation coordinator's scheduled
layout path. This also removes a band when the replacement badge has the same label and layout.

`editor.linkPreview(atUTF16:)` returns `EditorLinkPreview` with the visible label, safe target and
source line's agent thread. Add an optional `onPreviewLink: ((EditorLinkPreview) -> Void)?` to
`MobileEditorEmbedHost`. In `openLink(atUTF16:)`, prefer it when present:

```swift
if let request = linkPreview(atUTF16: offset), let preview = embeds.host?.onPreviewLink {
  preview(request)
  return true
}
```

Keep the existing `onOpenLink` fallback for older hosts. In `linkAtPoint`, permit either callback;
retain the content/embed exclusion checks. A phone host should install `onPreviewLink` and present
a `PhoneNoteLinkPreview` instead of immediately opening an external page.

## App composition hooks

Place the following above the current note editor:

```swift
PhoneOrchestratorIndicator(
  activity: workspace.workingActivity, currentPath: workspace.activePath,
  online: workspace.online
) { workspace.openAnnotationThread(nil, turn: $0) }
```

The indicator distinguishes work on the current note from another note, hides when offline/idle,
and uses a static dot with Reduce Motion. The activity owner must still reject stale status
snapshots and clear nil-turn activity only when its trigger also matches the completed turn.

For a note link, retain `PhoneNoteLinkRequest(link: request)` as the sheet identity and create a
`PhoneNoteLinkPreviewModel` with three injected closures:

- `isCurrent`: read live workspace identity/generation. A dismissed or replaced connection must
  never finish a saved-source load into a newer preview or follow an old link.
- `cachedNote(target, subpath)`: resolve within the current workspace, then return a local note's
  path/text or nil. Use the current in-memory note when available so unsaved typing is preserved.
  Do not download a note merely because its preview opened.
- `savedSources(threadID)`: read exactly that thread's stored `sources` from the agent store/cache;
  an authenticated host thread refresh is permitted, but never fetch the external URL itself.

Pass the existing safe `openEditorLink(target, from: sourceNote)` action as the preview's explicit
Open callback. Recheck current authority in that callback if it defers navigation. External
previews retain a local URL/label fallback when the stored source is unavailable. Note excerpts
are plain text, limited to six lines, 240 characters per line and a 4,096-character scan. No web
view, link-metadata fetch, HTML execution or bearer URL is used. Thread chat already has its own
stored-source preview in `MobileMarkdownView` and remains unchanged.
