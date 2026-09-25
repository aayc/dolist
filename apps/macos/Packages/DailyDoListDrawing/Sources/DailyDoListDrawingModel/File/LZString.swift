// A port of LZ-String 1.5.0's base64 codec (lz-string/libs/lz-string.js), which the Obsidian
// Excalidraw plugin uses for `compressed-json` drawings.
//
// MIT License
//
// Copyright (c) 2013 pieroxy
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import Foundation

/// LZ-String's `compressToBase64` and `decompressFromBase64`, on UTF-16 code units like the
/// JavaScript original, so output matches it character for character.
public enum LZString {
  static let base64Alphabet = Array(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".utf16)

  static let base64Values: [UInt16: Int] = {
    var values: [UInt16: Int] = [:]
    for (index, unit) in base64Alphabet.enumerated() { values[unit] = index }
    return values
  }()

  public static func compressToBase64(_ input: String) -> String {
    let units = compress(Array(input.utf16), bitsPerChar: 6) { base64Alphabet[$0] }
    var result = String(decoding: units, as: UTF16.self)
    switch units.count % 4 {
    case 1: result += "==="
    case 2: result += "=="
    case 3: result += "="
    default: break
    }
    return result
  }

  /// nil when the input isn't valid LZ-String data (JavaScript returns null or "").
  public static func decompressFromBase64(_ input: String) -> String? {
    let units = Array(input.utf16)
    guard !units.isEmpty else { return nil }
    guard
      let output = decompress(
        length: units.count, resetValue: 32,
        next: { index in index < units.count ? (base64Values[units[index]] ?? 0) : 0 })
    else { return nil }
    return String(decoding: output, as: UTF16.self)
  }

  // MARK: Compression

  private struct BitWriter {
    let bitsPerChar: Int
    let character: (Int) -> UInt16
    var data: [UInt16] = []
    var value = 0
    var position = 0

    mutating func write(_ bits: Int, count: Int) {
      var bits = bits
      for _ in 0..<count {
        value = (value << 1) | (bits & 1)
        if position == bitsPerChar - 1 {
          position = 0
          data.append(character(value))
          value = 0
        } else {
          position += 1
        }
        bits >>= 1
      }
    }

    /// The "1 then zeros" marker of a 16-bit literal, written high bit first like the original.
    mutating func writeMarker(_ marker: Int, count: Int) {
      var marker = marker
      for _ in 0..<count {
        value = (value << 1) | marker
        if position == bitsPerChar - 1 {
          position = 0
          data.append(character(value))
          value = 0
        } else {
          position += 1
        }
        marker = 0
      }
    }

    mutating func flush() {
      while true {
        value <<= 1
        if position == bitsPerChar - 1 {
          data.append(character(value))
          break
        }
        position += 1
      }
    }
  }

  static func compress(_ input: [UInt16], bitsPerChar: Int, character: @escaping (Int) -> UInt16)
    -> [UInt16]
  {
    var singles: [UInt16: Int] = [:]
    var pendingSingles = Set<UInt16>()
    var pairs: [UInt64: Int] = [:]
    var enlargeIn = 2
    var dictSize = 3
    var numBits = 2
    var writer = BitWriter(bitsPerChar: bitsPerChar, character: character)
    // w: nothing yet, a single character, or a longer dictionary entry (its code).
    var wCode: Int?
    var wSingle: UInt16?

    func emitW() {
      if let single = wSingle, pendingSingles.contains(single) {
        if single < 256 {
          writer.write(0, count: numBits)
          writer.write(Int(single), count: 8)
        } else {
          writer.writeMarker(1, count: numBits)
          writer.write(Int(single), count: 16)
        }
        enlargeIn -= 1
        if enlargeIn == 0 {
          enlargeIn = 1 << numBits
          numBits += 1
        }
        pendingSingles.remove(single)
      } else if let wCode {
        writer.write(wCode, count: numBits)
      }
      enlargeIn -= 1
      if enlargeIn == 0 {
        enlargeIn = 1 << numBits
        numBits += 1
      }
    }

    for c in input {
      if singles[c] == nil {
        singles[c] = dictSize
        dictSize += 1
        pendingSingles.insert(c)
      }
      guard let current = wCode else {
        wCode = singles[c]
        wSingle = c
        continue
      }
      let key = UInt64(current) << 16 | UInt64(c)
      if let code = pairs[key] {
        wCode = code
        wSingle = nil
        continue
      }
      emitW()
      pairs[key] = dictSize
      dictSize += 1
      wCode = singles[c]
      wSingle = c
    }
    if wCode != nil { emitW() }
    writer.write(2, count: numBits)
    writer.flush()
    return writer.data
  }

  // MARK: Decompression

  static func decompress(length: Int, resetValue: Int, next: (Int) -> Int) -> [UInt16]? {
    var dictionary: [[UInt16]] = [[0], [1], [2]]
    var enlargeIn = 4
    var numBits = 3
    var result: [UInt16] = []
    var value = next(0)
    var position = resetValue
    var index = 1

    func readBits(_ count: Int) -> Int {
      var bits = 0
      var power = 1
      let maxPower = 1 << count
      while power != maxPower {
        let bit = value & position
        position >>= 1
        if position == 0 {
          position = resetValue
          value = next(index)
          index += 1
        }
        bits |= (bit > 0 ? 1 : 0) * power
        power <<= 1
      }
      return bits
    }

    let c: [UInt16]
    switch readBits(2) {
    case 0: c = [UInt16(readBits(8))]
    case 1: c = [UInt16(readBits(16))]
    default: return []
    }
    dictionary.append(c)
    var w = c
    result.append(contentsOf: c)
    while true {
      if index > length { return [] }
      var code = readBits(numBits)
      switch code {
      case 0:
        dictionary.append([UInt16(readBits(8))])
        code = dictionary.count - 1
        enlargeIn -= 1
      case 1:
        dictionary.append([UInt16(readBits(16))])
        code = dictionary.count - 1
        enlargeIn -= 1
      case 2:
        return result
      default:
        break
      }
      if enlargeIn == 0 {
        enlargeIn = 1 << numBits
        numBits += 1
      }
      let entry: [UInt16]
      if code < dictionary.count {
        entry = dictionary[code]
      } else if code == dictionary.count {
        entry = w + [w[0]]
      } else {
        return nil
      }
      result.append(contentsOf: entry)
      dictionary.append(w + [entry[0]])
      enlargeIn -= 1
      w = entry
      if enlargeIn == 0 {
        enlargeIn = 1 << numBits
        numBits += 1
      }
    }
  }
}
