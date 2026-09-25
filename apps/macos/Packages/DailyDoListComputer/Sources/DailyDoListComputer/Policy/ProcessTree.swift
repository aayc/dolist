import Darwin
import Foundation

/// Parent processes, to find the apps the helper runs under and where a target came from.
public protocol ProcessTreeReading: Sendable {
  var currentPID: Int32 { get }
  /// The parent of `pid`; nil when `pid` isn't running (or can't be read).
  func parent(of pid: Int32) -> Int32?
}

extension ProcessTreeReading {
  /// `pid`'s parent, grandparent, … up to (not including) launchd.
  func ancestors(of pid: Int32) -> [Int32] {
    var chain: [Int32] = []
    var current = pid
    while chain.count < 64, let parent = parent(of: current), parent > 1, parent != current,
      !chain.contains(parent)
    {
      chain.append(parent)
      current = parent
    }
    return chain
  }
}

/// `sysctl(KERN_PROC_PID)`.
public struct SystemProcessTree: ProcessTreeReading {
  public init() {}

  public var currentPID: Int32 { getpid() }

  public func parent(of pid: Int32) -> Int32? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0,
      size == MemoryLayout<kinfo_proc>.stride
    else { return nil }
    return info.kp_eproc.e_ppid
  }
}
