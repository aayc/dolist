/**
 * The harness registry: `settings.agent.harness` → a ready harness, or the problem that keeps it
 * from running. Each entry checks what its harness needs — Pi an OpenRouter key OpenRouter
 * accepts, Cursor the CLI installed and signed in — and loads the harness module on first use.
 */
import type { AgentHarnessKind, Logger } from "@ddl/core";
import { checkOpenRouterKey, type OpenRouterKeyCheck } from "../llm/openrouter";
import type { CursorCliStatus } from "./cursor/cli";
import type { Harness } from "./types";

export interface HarnessSetupContext {
  /** DDL_HOME: harnesses keep their private files below it. */
  home: string;
  logger: Logger;
  /** `OPENROUTER_API_KEY`, `DDL_OPENROUTER_BASE_URL`, `DDL_CURSOR_CLI`, and what the Cursor CLI needs. */
  env: NodeJS.ProcessEnv;
  openRouter?: { apiKey?: string; baseUrl?: string };
  checkOpenRouterKey?: (apiKey: string) => Promise<OpenRouterKeyCheck>;
  /** Replaces `agent status` (tests). */
  checkCursorCli?: () => Promise<CursorCliStatus>;
}

export type HarnessSetupResult = { harness: Harness } | { problem: string };

type HarnessSetup = (ctx: HarnessSetupContext) => Promise<HarnessSetupResult>;

const HARNESSES: Record<AgentHarnessKind, HarnessSetup> = {
  pi: setupPiHarness,
  cursor: setupCursorHarness,
};

export async function setupHarness(
  kind: AgentHarnessKind,
  ctx: HarnessSetupContext,
): Promise<HarnessSetupResult> {
  const setup = HARNESSES[kind] as HarnessSetup | undefined;
  if (!setup) return { problem: `Unknown agent harness "${String(kind)}".` };
  try {
    return await setup(ctx);
  } catch (error) {
    return { problem: `The agent harness failed to start: ${errorText(error)}` };
  }
}

async function setupPiHarness(ctx: HarnessSetupContext): Promise<HarnessSetupResult> {
  const apiKey = ctx.openRouter?.apiKey ?? ctx.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      problem:
        "OPENROUTER_API_KEY is not set. Add it to ~/.daily-do-list/.env (or the daemon's environment) and restart, run with DDL_AGENT_MODE=mock, or switch the agent harness to the Cursor CLI in Settings.",
    };
  }
  const baseUrl = ctx.openRouter?.baseUrl ?? (ctx.env.DDL_OPENROUTER_BASE_URL?.trim() || undefined);
  if (baseUrl) ctx.logger.info("Using a custom OpenRouter endpoint", { baseUrl });
  const checkKey =
    ctx.checkOpenRouterKey ??
    ((key: string) => checkOpenRouterKey(key, baseUrl ? { baseUrl } : {}));
  const check = await checkKey(apiKey);
  if (check.status === "invalid") {
    return {
      problem: `OpenRouter rejected OPENROUTER_API_KEY (${check.httpStatus}: ${check.message}). Put a valid key in ~/.daily-do-list/.env and restart.`,
    };
  }
  if (check.status === "unknown") {
    ctx.logger.warn("Could not verify the OpenRouter key; continuing", { reason: check.message });
  }
  const { createPiHarness } = await import("./pi");
  return {
    harness: createPiHarness({
      apiKey,
      home: ctx.home,
      logger: ctx.logger.child({ component: "harness" }),
      ...(baseUrl ? { baseUrl } : {}),
    }),
  };
}

async function setupCursorHarness(ctx: HarnessSetupContext): Promise<HarnessSetupResult> {
  const cursor = await import("./cursor");
  const binary = ctx.env.DDL_CURSOR_CLI?.trim() || undefined;
  const status = await (
    ctx.checkCursorCli ??
    (() => cursor.checkCursorCli({ ...(binary ? { binary } : {}), env: ctx.env }))
  )();
  const problem = cursor.cursorCliProblem(status);
  if (problem || status.state !== "ready")
    return { problem: problem ?? "The Cursor CLI isn't ready." };
  ctx.logger.info("Using the Cursor CLI harness", { binary: status.binary });
  const harness = cursor.createCursorHarness({
    home: ctx.home,
    logger: ctx.logger.child({ component: "harness" }),
    binary: status.binary,
    env: ctx.env,
  });
  harness.stopLeftovers().catch((error: unknown) => {
    ctx.logger.warn("Couldn't check for leftover Cursor CLI processes", {
      error: errorText(error),
    });
  });
  return { harness };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
