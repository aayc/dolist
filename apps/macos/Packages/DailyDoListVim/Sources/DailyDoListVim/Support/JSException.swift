/// A JavaScript exception raised by vim.js or the editor adapter (a `RangeError`, a regex
/// `SyntaxError` from `:sort`, an `Error("Trailing characters…")` from `:set`…). It unwinds the
/// command exactly like in the web app, where vim.js resets the editor's vim state.
public struct JSException: Error, Equatable, Sendable, CustomStringConvertible {
  /// The constructor name: "Error", "SyntaxError", "RangeError", "TypeError".
  public let name: String
  public let message: String

  public init(name: String, message: String) {
    self.name = name
    self.message = message
  }

  /// `String(e)`, which vim.js shows as a notification: "Error: Mark not set".
  public var description: String { message.isEmpty ? name : name + ": " + message }

  static func error(_ message: String) -> JSException {
    JSException(name: "Error", message: message)
  }
  static func rangeError(_ message: String) -> JSException {
    JSException(name: "RangeError", message: message)
  }
  static func typeError(_ message: String) -> JSException {
    JSException(name: "TypeError", message: message)
  }

  static func syntax(_ error: JSRegexSyntaxError) -> JSException {
    JSException(name: "SyntaxError", message: error.message)
  }
}

extension JSRegExp {
  /// `new RegExp(pattern, flags)` throwing a JavaScript `SyntaxError`.
  static func make(_ pattern: VimText, _ flags: String = "") throws -> JSRegExp {
    do {
      return try JSRegExp(pattern, flags: flags)
    } catch {
      throw JSException.syntax(error)
    }
  }
}

extension JSException {
  /// The exception an error stands for (the engine only throws `JSException`s).
  static func from(_ error: any Error) -> JSException {
    error as? JSException ?? JSException(name: "Error", message: String(describing: error))
  }
}
