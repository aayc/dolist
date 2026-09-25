import { withTimeout } from "@ddl/core";
import { runCli } from "./cli";
import { type RunningDaemon, startDaemon } from "./server";

const SHUTDOWN_TIMEOUT_MS = 10_000;

function installSignalHandlers(daemon: RunningDaemon): void {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) {
      process.stderr.write(`Received ${signal} again; exiting immediately\n`);
      process.exit(1);
    }
    stopping = true;
    process.stdout.write(`\nShutting down (${signal})…\n`);
    withTimeout(daemon.close(), SHUTDOWN_TIMEOUT_MS, "Shutdown timed out").then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
}

const args = process.argv.slice(2);
if (args.length > 0) {
  const code = await runCli(args, {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  // Exit once the output is flushed (pipes are asynchronous on macOS).
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
} else {
  try {
    const daemon = await startDaemon();
    installSignalHandlers(daemon);
    process.stdout.write(`\n  Daily Do List is running at ${daemon.url}\n\n`);
  } catch (error) {
    process.stderr.write(
      `Daily Do List daemon failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
