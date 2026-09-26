import { type LogEntry, recordingLogger } from "@ddl/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createErrorHandler } from "./errors";

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function request(thrown: Error): Promise<{ status: number; entries: LogEntry[] }> {
  const logger = recordingLogger();
  const app = new Hono();
  app.onError(createErrorHandler(logger));
  app.get("/boom", () => {
    throw thrown;
  });
  const response = await app.request("/boom");
  return { status: response.status, entries: logger.entries };
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
    expect(entries).toContainEqual(
      expect.objectContaining({ level: "error", message: "Request failed" }),
    );
  });
});
