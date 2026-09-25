import { runCli } from "./cli";

/** node:sqlite warns that it is experimental each time a process opens it; keep other warnings. */
function quietSqliteWarning(): void {
  const printers = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
    for (const print of printers) print(warning);
  });
}

quietSqliteWarning();
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => controller.abort());
}
process.exitCode = await runCli(
  process.argv.slice(2),
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  { signal: controller.signal },
);
