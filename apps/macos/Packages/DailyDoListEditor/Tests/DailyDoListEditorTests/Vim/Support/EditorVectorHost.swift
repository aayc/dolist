import AppKit
import DailyDoListVim
import DailyDoListVimTestSupport

@testable import DailyDoListEditor

/// The real editor as a vim vector host: one offscreen `MarkdownEditorController` reused for every
/// case, laid out like the vectors' oracle (16 pt monospaced lines of the header's height, a
/// viewport of the header's rows, no padding, no wrapping, no live preview).
@MainActor
final class EditorVectorHosts {
  let controller: MarkdownEditorController

  init(header: VimVectorHeader, livePreview: Bool = false) {
    controller = MarkdownEditorController(
      configuration: EditorConfiguration(fontSize: 16, livePreview: livePreview, readableLineLength: false, vimMode: true),
      uniformMetrics: .init(lineHeight: CGFloat(header.lineHeight), tabSize: header.tabSize))
    controller.containerView.showsPanel = false
    controller.view.frame = NSRect(x: 0, y: 0, width: 900, height: CGFloat(header.rows) * CGFloat(header.lineHeight))
    controller.view.layoutSubtreeIfNeeded()
    controller.scrollView.hasVerticalScroller = false
    controller.markdownTextView.frame.size.width = controller.scrollView.contentSize.width
  }

  /// The editor reset for `spec` (vim is attached by the replay).
  func host(for spec: VimVectorEditorSpec) -> any VimVectorHost {
    controller.vim = nil
    controller.setUniformMetrics(.init(lineHeight: CGFloat(spec.header.lineHeight), tabSize: spec.tabSize))
    controller.replaceDocument(withExactly: spec.doc.nsString)
    controller.noteUndoManager.groupsByEvent = false
    let host = controller.vimHost
    host.tabSize = spec.tabSize
    host.indentUnit = spec.indentUnit
    let clock = spec.clock
    host.clock = { clock }
    return host
  }
}

extension TextViewVimHost: VimVectorHost {
  public func replayAttach(_ vim: Vim) -> VimSession {
    controller.vim = vim
    return session!
  }

  /// The oracle's native edit, applied through the editor's pipeline as the editor's own edit
  /// (reported to vim with the selection afterwards, even when nothing changed).
  public func replayNativeEdit(_ token: String, in session: VimSession) -> Bool {
    guard !vimIsReadOnly, let edit = VimVectorReplayer.nativeEdit(for: token, in: session) else { return false }
    if edit.changes.isEmpty {
      setSelection(edit.selection)
      pendingScroll = selection.main
      pendingSelectionMove = true
      flushToVim()
    } else {
      applyEditorEdit(edit.changes.changes, selection: edit.selection, userEvent: edit.userEvent)
    }
    return true
  }

  public func replayLayoutPass() {
    layoutManager.ensureLayout(for: textContainer)
    textView.sizeToFit()
    vimScroll(top: vimViewport.scrollTop, left: nil)
    applyPendingScroll()
  }

  public func replayScroll(toLine line: Int) {
    layoutManager.ensureLayout(for: textContainer)
    textView.sizeToFit()
    vimScroll(top: Double(line) * vimLineHeight, left: nil)
  }

  public var replayScrollOffset: Double { vimViewport.scrollTop }
}
