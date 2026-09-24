import Darwin
import Foundation

/// Launch timeline for performance work: with `DDL_BOOT_TRACE=1` in the environment, each phase
/// is printed to stderr with the milliseconds since the process started. A no-op otherwise.
public enum BootTrace {
  public static let isEnabled = ProcessInfo.processInfo.environment["DDL_BOOT_TRACE"] == "1"

  /// When the kernel started this process (the first `mark` if that can't be read).
  private static let processStart: Date = {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0 else { return Date() }
    let start = info.kp_proc.p_un.__p_starttime
    return Date(timeIntervalSince1970: TimeInterval(start.tv_sec) + TimeInterval(start.tv_usec) / 1_000_000)
  }()

  public static func mark(_ phase: @autoclosure () -> String) {
    guard isEnabled else { return }
    let milliseconds = Int(Date().timeIntervalSince(processStart) * 1000)
    FileHandle.standardError.write(Data("boot-trace +\(milliseconds)ms \(phase())\n".utf8))
  }
}
