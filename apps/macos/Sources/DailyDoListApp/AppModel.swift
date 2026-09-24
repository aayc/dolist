import DailyDoListAgent
import DailyDoListClient
import DailyDoListDaemon
import DailyDoListDomain
import DailyDoListEditor
import DailyDoListModels
import Foundation
import Observation

// Root state of the app. (Initial skeleton — replaced by the full app shell.)

@MainActor
@Observable
public final class AppModel {
  public let supervisor: DaemonSupervisor
  public private(set) var client: DaemonClient?
  public private(set) var agent: AgentStore?
  public var settings: AppSettings = .defaults

  public init(supervisor: DaemonSupervisor = DaemonSupervisor()) {
    self.supervisor = supervisor
  }
}
