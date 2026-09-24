export interface ImageSize {
  width: number;
  height: number;
}

/** Start-of-frame markers carry the image dimensions (DHT/JPG/DAC share the range but don't). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Reads width/height from a JPEG header without decoding the image. */
export function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  const at = (i: number): number => bytes[i] ?? 0;
  if (bytes.length < 4 || at(0) !== 0xff || at(1) !== 0xd8) return undefined;
  let i = 2;
  while (i + 1 < bytes.length) {
    if (at(i) !== 0xff) return undefined;
    const marker = at(i + 1);
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Standalone markers have no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    // End of image / start of scan before any frame header: no dimensions available.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (i + 3 >= bytes.length) return undefined;
    const length = (at(i + 2) << 8) | at(i + 3);
    if (isStartOfFrame(marker)) {
      if (i + 8 >= bytes.length) return undefined;
      const height = (at(i + 5) << 8) | at(i + 6);
      const width = (at(i + 7) << 8) | at(i + 8);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (length < 2) return undefined;
    i += 2 + length;
  }
  return undefined;
}

/** Like {@link jpegSize} for base64 data; decodes only the header region when possible. */
export function jpegSizeFromBase64(data: string): ImageSize | undefined {
  const head = jpegSize(Buffer.from(data.slice(0, 4096), "base64"));
  return head ?? (data.length > 4096 ? jpegSize(Buffer.from(data, "base64")) : undefined);
}
