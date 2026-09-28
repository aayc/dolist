import DailyDoListMobileKit
import Foundation
import SwiftUI

extension RecoveryExportStaging {
  /// Outside the managed storage root: protection migration rewrites every file's class there,
  /// and staged exports must keep complete protection.
  static let app = RecoveryExportStaging(
    rootDirectory: FileManager.default.temporaryDirectory.appendingPathComponent(
      "RecoveryExports", isDirectory: true))
}

private struct RecoveryExportStagingKey: EnvironmentKey {
  static let defaultValue = RecoveryExportStaging.app
}

extension EnvironmentValues {
  var recoveryExportStaging: RecoveryExportStaging {
    get { self[RecoveryExportStagingKey.self] }
    set { self[RecoveryExportStagingKey.self] = newValue }
  }
}
