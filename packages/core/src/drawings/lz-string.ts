/**
 * The base64 form of LZ-String, vendored from lz-string 1.5.0 (https://github.com/pieroxy/lz-string)
 * because `@ddl/core` has no dependencies. The Obsidian Excalidraw plugin stores drawings as
 * `compressToBase64` output (its `compressed-json` blocks), so this must stay bit-compatible with
 * the library. Differences: typed, the bit loops are shared helpers, invalid input returns null
 * instead of a garbage string, and decompression stops at `MAX_OUTPUT_CHARS`.
 *
 * MIT License
 *
 * Copyright (c) 2013 pieroxy
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/**
 * LZW output can grow quadratically with crafted input; a real drawing decompresses to a few MB.
 * Past this many UTF-16 code units the input is treated as invalid.
 */
const MAX_OUTPUT_CHARS = 64 * 1024 * 1024;

let base64Values: Int8Array | undefined;

/** The library maps characters outside the alphabet to `undefined`, which its bit math reads as 0. */
function base64Value(code: number): number {
  if (!base64Values) {
    base64Values = new Int8Array(128);
    for (let i = 0; i < BASE64_ALPHABET.length; i++)
      base64Values[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return code < 128 ? base64Values[code]! : 0;
}

/** `LZString.compressToBase64`. */
export function compressToBase64(input: string): string {
  const out = compress(input, 6, (value) => BASE64_ALPHABET.charAt(value));
  switch (out.length % 4) {
    case 1:
      return `${out}===`;
    case 2:
      return `${out}==`;
    case 3:
      return `${out}=`;
    default:
      return out;
  }
}

/**
 * `LZString.decompressFromBase64`: the original text, `""` for an empty or truncated stream, or
 * null when `input` isn't LZ-String base64. Callers strip line breaks first.
 */
export function decompressFromBase64(input: string): string | null {
  if (input === "") return null;
  return decompress(input.length, 32, (index) => base64Value(input.charCodeAt(index)));
}

function compress(
  uncompressed: string,
  bitsPerChar: number,
  charFor: (value: number) => string,
): string {
  const dictionary = new Map<string, number>();
  const toCreate = new Set<string>();
  const data: string[] = [];
  let w = "";
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  let bits = 0;
  let position = 0;

  const write = (count: number, value: number) => {
    for (let i = 0; i < count; i++) {
      bits = (bits << 1) | (value & 1);
      if (position === bitsPerChar - 1) {
        position = 0;
        data.push(charFor(bits));
        bits = 0;
      } else {
        position++;
      }
      value >>= 1;
    }
  };
  const countDown = () => {
    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  };
  const emit = (phrase: string) => {
    if (toCreate.has(phrase)) {
      const code = phrase.charCodeAt(0);
      if (code < 256) {
        write(numBits, 0);
        write(8, code);
      } else {
        write(numBits, 1);
        write(16, code);
      }
      countDown();
      toCreate.delete(phrase);
    } else {
      write(numBits, dictionary.get(phrase)!);
    }
    countDown();
  };

  for (let i = 0; i < uncompressed.length; i++) {
    const c = uncompressed.charAt(i);
    if (!dictionary.has(c)) {
      dictionary.set(c, dictSize++);
      toCreate.add(c);
    }
    const wc = w + c;
    if (dictionary.has(wc)) {
      w = wc;
    } else {
      emit(w);
      dictionary.set(wc, dictSize++);
      w = c;
    }
  }
  if (w !== "") emit(w);
  write(numBits, 2);
  for (;;) {
    bits <<= 1;
    if (position === bitsPerChar - 1) {
      data.push(charFor(bits));
      break;
    }
    position++;
  }
  return data.join("");
}

function decompress(
  length: number,
  resetValue: number,
  next: (index: number) => number,
): string | null {
  const dictionary: string[] = [];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  let value = next(0);
  let position = resetValue;
  let index = 1;
  let outputChars = 0;

  const read = (count: number): number => {
    let bits = 0;
    for (let power = 1, max = 2 ** count; power !== max; power *= 2) {
      const bit = value & position;
      position >>= 1;
      if (position === 0) {
        position = resetValue;
        value = next(index++);
      }
      if (bit > 0) bits += power;
    }
    return bits;
  };

  let first: string;
  switch (read(2)) {
    case 0:
      first = String.fromCharCode(read(8));
      break;
    case 1:
      first = String.fromCharCode(read(16));
      break;
    case 2:
      return "";
    default:
      return null;
  }
  dictionary[3] = first;
  let w = first;
  const result = [first];
  outputChars = first.length;
  for (;;) {
    if (index > length) return "";
    let code = read(numBits);
    switch (code) {
      case 0:
        dictionary[dictSize++] = String.fromCharCode(read(8));
        code = dictSize - 1;
        enlargeIn--;
        break;
      case 1:
        dictionary[dictSize++] = String.fromCharCode(read(16));
        code = dictSize - 1;
        enlargeIn--;
        break;
      case 2:
        return result.join("");
    }
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
    let entry: string;
    const known = dictionary[code];
    if (known) entry = known;
    else if (code === dictSize) entry = w + w.charAt(0);
    else return null;
    outputChars += entry.length;
    if (outputChars > MAX_OUTPUT_CHARS) return null;
    result.push(entry);
    dictionary[dictSize++] = w + entry.charAt(0);
    enlargeIn--;
    w = entry;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  }
}
