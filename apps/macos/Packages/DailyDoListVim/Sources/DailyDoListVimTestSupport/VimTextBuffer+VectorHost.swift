import DailyDoListVim

/// The reference buffer as a replay host, with the oracle's fixed viewport from the header.
extension VimTextBuffer: VimVectorHost {
  /// A buffer set up for `spec` like the vectors' oracle editor.
  public static func vectorHost(_ spec: VimVectorEditorSpec) -> VimTextBuffer {
    let buffer = VimTextBuffer(spec.doc, tabSize: spec.tabSize, indentUnit: spec.indentUnit)
    let clock = spec.clock
    buffer.clock = { clock }
    buffer.lineHeight = spec.header.lineHeight
    buffer.clientHeight = Double(spec.header.rows) * spec.header.lineHeight
    if let textHeight = spec.header.textHeight { buffer.textHeight = textHeight }
    if let charWidth = spec.header.charWidth { buffer.charWidth = charWidth }
    return buffer
  }

  public func replayAttach(_ vim: Vim) -> VimSession { attach(to: vim) }

  public func replayNativeEdit(_ token: String, in session: VimSession) -> Bool {
    performNativeEdit(for: token)
  }

  public func replayLayoutPass() { measure() }

  public func replayScroll(toLine line: Int) { scroll(toLine: line) }

  public var replayScrollOffset: Double { scrollTop }
}
