import Foundation

/// The Ctrl keys vim owns outside insert mode, for the shortcut policy (a port of the web editor's
/// `vim-keys.ts`): vim.js's default normal/visual bindings plus the Ctrl keys a vimrc mapping
/// starts with.
enum VimCtrlKeys {
  static let defaults: Set<String> = [
    "<C-Space>", "<C-BS>", "<C-n>", "<C-p>", "<C-[>", "<C-c>", "<C-Esc>", "<C-f>", "<C-b>", "<C-d>", "<C-u>", "<C-w>",
    "<C-i>", "<C-o>", "<C-e>", "<C-y>", "<C-v>", "<C-q>", "<C-r>", "<C-a>", "<C-x>",
  ]

  /// The Ctrl key (`<C-…>`, lowercase letter) a mapping's left-hand side starts with.
  static func ctrlKeys(of lhs: String) -> [String] {
    let pattern = /^<[Cc]-(?:[Ss]-)?([^>]+)>/
    guard let match = lhs.firstMatch(of: pattern) else { return [] }
    let key = String(match.1)
    return ["<C-\(key.count == 1 ? key.lowercased() : key)>"]
  }

  /// Whether vim claims `key` (vim notation) given the Ctrl keys mappings added.
  static func isClaimed(_ key: String, mapped: Set<String>) -> Bool {
    var normalized = key
    if key.count == 5, key.hasPrefix("<C-"), key.hasSuffix(">") {
      let letter = key[key.index(key.startIndex, offsetBy: 3)]
      normalized = "<C-\(letter.lowercased())>"
    }
    return defaults.contains(normalized) || mapped.contains(normalized)
  }
}
