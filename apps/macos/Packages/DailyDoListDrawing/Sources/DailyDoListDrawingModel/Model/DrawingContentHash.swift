import Foundation

/// A fast, stable 64-bit hash (FNV-1a) of a scene's content, for caches of rendered previews.
public enum DrawingContentHash {
  public static func hash(_ text: String) -> UInt64 {
    var hash: UInt64 = 0xCBF2_9CE4_8422_2325
    for byte in text.utf8 {
      hash ^= UInt64(byte)
      hash = hash &* 0x0000_0100_0000_01B3
    }
    return hash
  }

  /// The hash of a scene as it would be saved.
  public static func hash(_ scene: ExcalidrawScene) -> UInt64 {
    hash(SceneCodec.encode(scene, indent: ""))
  }
}
