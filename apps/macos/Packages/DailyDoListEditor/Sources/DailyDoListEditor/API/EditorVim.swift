import Foundation

/// Vim's mode line: the mode, the keys of a command being typed and macro recording (what the
/// web app's status bar shows). Reported to the delegate only when it changes.
public struct EditorVimStatus: Hashable, Sendable {
  public enum Mode: String, Sendable, CaseIterable {
    case normal, insert, replace, visual
    case visualLine = "visual-line"
    case visualBlock = "visual-block"

    /// The status bar's label ("NORMAL", "V-LINE"…).
    public var label: String {
      switch self {
      case .normal: "NORMAL"
      case .insert: "INSERT"
      case .replace: "REPLACE"
      case .visual: "VISUAL"
      case .visualLine: "V-LINE"
      case .visualBlock: "V-BLOCK"
      }
    }
  }

  public var mode: Mode
  /// Keys of a command still being typed (vim's "showcmd"): `2d`, `"a`. Empty in insert mode.
  public var pending: String
  /// The register a macro is being recorded into (`@q`), if any.
  public var recording: String?

  public init(mode: Mode, pending: String = "", recording: String? = nil) {
    self.mode = mode
    self.pending = pending
    self.recording = recording
  }
}

/// A tab to switch to: `delta` tabs away (wrapping around) or the 0-based tab `index`.
public enum EditorTabSwitch: Hashable, Sendable {
  case delta(Int)
  case index(Int)
}

/// An app command vim asks the host for (the web editor's `EditorCallbacks`).
public enum EditorVimRequest: Hashable, Sendable {
  /// `:wa`: save every open note.
  case saveAll
  /// `:q`, `:q!`, `:tabclose`, `:bd` (and `:wq`, `:x` after saving): close this note's tab, or
  /// every tab with `all` (`:qa`, `:wqa`, `:xa`).
  case close(all: Bool)
  /// `:e <note>`, `:tabedit <note>`: open a note by name or path; nil lets the user pick one.
  case openNote(String?, newTab: Bool)
  /// `gt`, `gT`, `:tabnext`, `:bnext`…
  case switchTab(EditorTabSwitch)
  /// `:obcommand <id>`: run an app command.
  case runCommand(String)
}

/// What the host did with an `EditorVimRequest`.
public enum EditorVimRequestResult: Sendable {
  case done
  /// The host doesn't support the request here (vim says "`:quit` isn't available here").
  case unavailable
  /// The request failed (`:obcommand` with an unknown id: "No command …").
  case failed
}

/// A line of the vimrc vim rejected.
public struct VimrcProblem: Hashable, Sendable {
  /// 0-based line in the vimrc.
  public var line: Int
  public var message: String

  public init(line: Int, message: String) {
    self.line = line
    self.message = message
  }
}
