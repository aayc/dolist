import Darwin
import Foundation

extension ComputerSystem {
  /// The real Mac.
  public static var live: ComputerSystem {
    ComputerSystem(
      accessibility: LiveAccessibility(), workspace: LiveWorkspace(), windows: LiveWindowList(),
      events: LiveEventPoster(), capture: LiveScreenCapture(), permissions: SystemPermissions(),
      processes: SystemProcessTree(), clock: SystemComputerClock())
  }
}

/// `ddl-computer serve`: JSON lines on stdin and stdout, logs on stderr.
public enum HelperMain {
  /// After stdin closes, how long requests already read may still run before the helper exits.
  static let drainLimit: TimeInterval = 10

  /// Never returns. Exits once stdin has closed (the daemon quit or let go of the helper) and
  /// every request read has been answered, or `drainLimit` seconds after stdin closed, whichever
  /// comes first; or as soon as stdout closes.
  @MainActor
  public static func serve(log: any HelperLogging = StandardErrorLog()) -> Never {
    signal(SIGPIPE, SIG_IGN)
    let system = ComputerSystem.live
    let targets = ProtectedTargets.standard(environment: ProcessInfo.processInfo.environment)
    let service = ComputerService(
      system: system, configuration: ComputerConfiguration(protectedTargets: targets))
    let server = RPCServer(
      service: service, output: StandardOutputWriter(log: log), log: log, clock: system.clock)
    let (lines, continuation) = AsyncStream.makeStream(of: InputLine.self)
    readStandardInput(into: continuation, log: log)
    log.started(version: ComputerService.protocolVersion, pid: getpid())
    Task.detached {
      await server.serve(lines)
      exit(0)
    }
    // NSWorkspace updates its list of apps on the main run loop; the timer keeps the run loop
    // from returning while it has nothing else to do.
    Timer.scheduledTimer(withTimeInterval: 3_600, repeats: true) { _ in }
    RunLoop.main.run()
    exit(0)
  }

  private static func readStandardInput(
    into continuation: AsyncStream<InputLine>.Continuation, log: any HelperLogging
  ) {
    let thread = Thread {
      var reader = LineReader()
      var buffer = [UInt8](repeating: 0, count: 64 * 1_024)
      while true {
        let count = buffer.withUnsafeMutableBytes { read(STDIN_FILENO, $0.baseAddress, $0.count) }
        if count > 0 {
          for line in reader.append(buffer[0..<count]) { continuation.yield(line) }
        } else if count < 0 && errno == EINTR {
          continue
        } else {
          break
        }
      }
      for line in reader.finish() { continuation.yield(line) }
      log.inputClosed()
      continuation.finish()
      Thread.sleep(forTimeInterval: drainLimit)
      exit(0)
    }
    thread.name = "ddl-computer stdin"
    thread.start()
  }
}

/// Writes response lines to stdout, unbuffered. A closed stdout means nobody reads the answers
/// any more, so the helper exits.
struct StandardOutputWriter: ResponseWriting {
  let log: any HelperLogging

  func write(line: String) {
    var bytes = Array(line.utf8)
    bytes.append(0x0A)
    var offset = 0
    while offset < bytes.count {
      let written = bytes.withUnsafeBytes { raw in
        Darwin.write(STDOUT_FILENO, raw.baseAddress! + offset, raw.count - offset)
      }
      if written > 0 {
        offset += written
      } else if written < 0 && errno == EINTR {
        continue
      } else {
        log.outputClosed()
        exit(0)
      }
    }
  }
}
