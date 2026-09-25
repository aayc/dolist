import CoreGraphics
import Foundation

@testable import DailyDoListComputer

/// A clock whose sleeps finish at once, advancing time.
final class FakeClock: ComputerClock, @unchecked Sendable {
  private let lock = NSLock()
  private let origin = ContinuousClock.now
  private var elapsed: Duration = .zero
  private var recorded: [Duration] = []
  /// Time that passes on every `now` read, to drive deadlines forward in walks.
  var tick: Duration = .zero

  var now: ContinuousClock.Instant {
    lock.withLock {
      elapsed += tick
      return origin + elapsed
    }
  }

  var sleeps: [Duration] { lock.withLock { recorded } }

  func advance(by duration: Duration) { lock.withLock { elapsed += duration } }

  func sleep(for duration: Duration) async throws {
    try Task.checkCancellation()
    lock.withLock {
      recorded.append(duration)
      elapsed += duration
    }
  }
}

final class FakeWorkspace: WorkspaceAPI, @unchecked Sendable {
  private let lock = NSLock()
  private var running: [RunningApp] = []
  private var installed: [InstalledApp] = []
  private var launches: [URL] = []
  private var activations: [Int32] = []
  private var nextPID: Int32 = 5_000
  /// What `openApplication` does: the app it starts (nil: launching fails).
  var launchedApp: ((InstalledApp, Int32) -> RunningApp?)? = { app, pid in
    RunningApp(
      pid: pid, localizedName: app.name, bundleId: app.bundleId, bundleURL: app.url)
  }
  /// Whether `activate` makes the app active.
  var activationWorks = true

  var launched: [URL] { lock.withLock { launches } }
  var activated: [Int32] { lock.withLock { activations } }

  func addRunning(_ app: RunningApp) { lock.withLock { running.append(app) } }
  func addInstalled(_ app: InstalledApp) { lock.withLock { installed.append(app) } }

  func runningApplications() async -> [RunningApp] { lock.withLock { running } }

  func runningApplication(pid: Int32) async -> RunningApp? {
    lock.withLock { running.first { $0.pid == pid } }
  }

  func installedApplications() async -> [InstalledApp] { lock.withLock { installed } }

  func applicationURL(bundleIdentifier: String) async -> URL? {
    lock.withLock {
      installed.first { $0.bundleId.caseInsensitiveCompare(bundleIdentifier) == .orderedSame }?.url
    }
  }

  func installedApplication(at url: URL) async -> InstalledApp? {
    lock.withLock { installed.first { $0.url == url } }
  }

  func openApplication(at url: URL) async throws -> Int32 {
    try lock.withLock {
      launches.append(url)
      guard let app = installed.first(where: { $0.url == url }),
        let started = launchedApp?(app, nextPID)
      else { throw ComputerError.failed("launch failed") }
      nextPID += 1
      running.append(started)
      return started.pid
    }
  }

  func activate(pid: Int32) async -> Bool {
    lock.withLock {
      activations.append(pid)
      guard activationWorks, let index = running.firstIndex(where: { $0.pid == pid }) else {
        return activationWorks
      }
      for other in running.indices { running[other].isActive = false }
      running[index].isActive = true
      return true
    }
  }
}

final class FakeWindows: WindowListing, @unchecked Sendable {
  private let lock = NSLock()
  private var list: [WindowInfo] = []

  func set(_ windows: [WindowInfo]) { lock.withLock { list = windows } }

  func onScreenWindows() -> [WindowInfo] { lock.withLock { list } }
}

final class FakeEvents: EventPosting, @unchecked Sendable {
  private let lock = NSLock()
  private var events: [(event: InputEvent, pid: Int32)] = []

  var posted: [InputEvent] { lock.withLock { events.map(\.event) } }
  var targets: Set<Int32> { lock.withLock { Set(events.map(\.pid)) } }

  func post(_ event: InputEvent, to pid: Int32) throws {
    lock.withLock { events.append((event, pid)) }
  }
}

final class FakeCapture: ScreenCapturing, @unchecked Sendable {
  private let lock = NSLock()
  private var requests: [(pid: Int32, frame: Rect)] = []
  var imageSize = (width: 2_400, height: 1_600)
  var displayBounds = Rect(x: 0, y: 0, width: 1_512, height: 982)

  var windowRequests: [(pid: Int32, frame: Rect)] { lock.withLock { requests } }

  func captureWindow(pid: Int32, frame: Rect, title: String) async throws -> CapturedImage {
    lock.withLock { requests.append((pid, frame)) }
    return CapturedImage(try solidImage(width: imageSize.width, height: imageSize.height))
  }

  func captureMainDisplay() async throws -> (image: CapturedImage, bounds: Rect) {
    (CapturedImage(try solidImage(width: imageSize.width, height: imageSize.height)), displayBounds)
  }
}

struct FakePermissions: PermissionProbing {
  var accessibilityGranted = true
  var screenRecordingGranted = true

  func accessibility() -> Bool { accessibilityGranted }
  func screenRecording() -> Bool { screenRecordingGranted }
}

struct FakeProcessTree: ProcessTreeReading {
  var currentPID: Int32 = 900
  var parents: [Int32: Int32] = [900: 800, 800: 700, 700: 1]

  func parent(of pid: Int32) -> Int32? { parents[pid] }
}

/// A synthetic image (memory only).
func solidImage(width: Int, height: Int) throws -> CGImage {
  guard
    let context = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { throw ComputerError.failed("no context") }
  context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  guard let image = context.makeImage() else { throw ComputerError.failed("no image") }
  return image
}
