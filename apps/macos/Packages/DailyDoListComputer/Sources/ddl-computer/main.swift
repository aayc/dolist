import DailyDoListComputer
import Foundation

// `ddl-computer serve` is the only real command: the daemon spawns it and talks JSON lines over
// stdin and stdout (see apps/macos/README.md). Everything else is for humans.
let usage = """
  usage: ddl-computer serve       JSON-lines requests on stdin, responses on stdout
         ddl-computer --version   the protocol version

  """

switch CommandLine.arguments.dropFirst().first {
case "serve":
  HelperMain.serve()
case "--version", "version":
  print("ddl-computer \(ComputerService.protocolVersion)")
case "--help", "-h", "help":
  print(usage, terminator: "")
default:
  FileHandle.standardError.write(Data(usage.utf8))
  exit(64)
}
