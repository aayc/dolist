import Foundation
import Security
import ServiceManagement

/// Whether the app opens at login (`SMAppService.mainApp`).
public enum LaunchAtLoginStatus: Equatable, Sendable {
  case enabled
  case disabled
  /// Registered, but the user must allow it in System Settings → General → Login Items.
  case requiresApproval
  /// Can't be used from this build; the text says why.
  case unavailable(String)
}

public enum LaunchAtLoginError: Error, Equatable, Sendable {
  case unavailable(String)
  case failed(String)
}

extension LaunchAtLoginError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .unavailable(let reason): reason
    case .failed(let detail): "Couldn't change the login item: \(detail)"
    }
  }
}

/// `SMAppService.mainApp` only works for a code-signed `.app` bundle (ad-hoc signing is enough
/// locally); a `swift run` executable gets an explanation instead of an opaque error.
@MainActor
struct LaunchAtLoginService {
  /// Why launch at login can't work for this process, or nil when it can.
  let unavailableReason: String?

  init(bundle: Bundle = .main) {
    unavailableReason = Self.unavailableReason(
      isAppBundle: bundle.bundleURL.pathExtension == "app",
      bundleIdentifier: bundle.bundleIdentifier,
      isSigned: Self.isCodeSigned())
  }

  static func unavailableReason(isAppBundle: Bool, bundleIdentifier: String?, isSigned: Bool) -> String? {
    if !isAppBundle {
      return """
        Launch at login needs the packaged app. Build it with apps/macos/scripts/build-app.sh \
        (a `swift run` build is a bare executable, not an app bundle).
        """
    }
    if bundleIdentifier == nil {
      return "Launch at login needs an app bundle with a bundle identifier (CFBundleIdentifier)."
    }
    if !isSigned {
      return """
        Launch at login needs a code-signed app. Sign it (build-app.sh signs ad hoc) and \
        relaunch.
        """
    }
    return nil
  }

  var status: LaunchAtLoginStatus {
    if let unavailableReason { return .unavailable(unavailableReason) }
    switch SMAppService.mainApp.status {
    case .enabled: return .enabled
    case .requiresApproval: return .requiresApproval
    case .notRegistered: return .disabled
    case .notFound:
      return .unavailable(
        "macOS can't register this copy of the app as a login item. Move it to /Applications and relaunch it.")
    @unknown default: return .disabled
    }
  }

  func setEnabled(_ enabled: Bool) throws(LaunchAtLoginError) {
    if let unavailableReason { throw .unavailable(unavailableReason) }
    do {
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
    } catch {
      throw .failed(error.localizedDescription)
    }
  }

  func openSystemSettings() {
    SMAppService.openSystemSettingsLoginItems()
  }

  /// This process carries a valid code signature (ad hoc counts). Only the signature itself is
  /// checked: validating resources hashes every file of the bundled daemon, which costs ~300 ms
  /// at launch (seconds on a cold disk), and the kernel already validates the executable's pages.
  static func isCodeSigned() -> Bool {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return false }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
      return false
    }
    let signatureOnly = SecCSFlags(
      rawValue: SecCSFlags.RawValue(kSecCSDoNotValidateResources | kSecCSDoNotValidateExecutable))
    return SecStaticCodeCheckValidity(staticCode, signatureOnly, nil) == errSecSuccess
  }
}
