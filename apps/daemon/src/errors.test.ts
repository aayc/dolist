import type { Logger } from "@ddl/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createErrorHandler } from "./errors";

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

function recordingLogger(entries: LogEntry[]): Logger {
  const logger: Logger = {
    debug: (message) => entries.push({ level: "debug", message }),
    info: (message) => entries.push({ level: "info", message }),
    warn: (message) => entries.push({ level: "warn", message }),
    error: (message) => entries.push({ level: "error", message }),
    child: () => logger,
  };
  return logger;
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function request(thrown: Error): Promise<{ status: number; entries: LogEntry[] }> {
  const entries: LogEntry[] = [];
  const app = new Hono();
  app.onError(createErrorHandler(recordingLogger(entries)));
  app.get("/boom", () => {
    throw thrown;
  });
  const response = await app.request("/boom");
  return { status: response.status, entries };
}

describe("createErrorHandler", () => {
  it("answers agent_unavailable with 503 without logging it as a failure", async () => {
    const { status, entries } = await request(
      namedError("AgentUnavailableError", "The agent is running on Desktop."),
    );
    expect(status).toBe(503);
    expect(entries.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("logs unexpected errors as failures", async () => {
    const { status, entries } = await request(new Error("unexpected"));
    expect(status).toBe(500);
    expect(entries).toContainEqual({ level: "error", message: "Request failed" });
  });
});
