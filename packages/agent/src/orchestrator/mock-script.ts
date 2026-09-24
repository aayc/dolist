import { toolResultText } from "@ddl/core";
import type { AgentScript, ScriptContext } from "../harness/scripted";
import type { HarnessSessionOptions } from "../harness/types";
import { parseDigestItems } from "../prompts/orchestrator";
import { TOOL } from "../tools/contracts";
import { riskyVerb } from "../tools/mock";

/** Tasks the mock orchestrator treats as having nothing digital to do. */
const NON_ACTIONABLE_RE =
  /\b(gym|workout|work out|yoga|walk the dog|call mom|call dad|laundry|dishes|vacuum|meditate)\b/i;

/**
 * The default script for `mode: "mock"`: a deterministic stand-in for the model that exercises
 * the whole pipeline (comments, subagents, streaming, artifacts, approvals) without any network.
 */
export function createMockScript(): (options: HarnessSessionOptions) => AgentScript {
  return (options) => (options.role === "orchestrator" ? mockOrchestrator : mockSubagent);
}

async function mockOrchestrator(ctx: ScriptContext): Promise<void> {
  for (const item of parseDigestItems(ctx.message)) {
    if (item.kind === "reply") {
      await ctx.callTool(TOOL.postComment, {
        taskId: item.taskId,
        text: "Thanks — noted.",
        summary: "Noted",
      });
      continue;
    }
    if (NON_ACTIONABLE_RE.test(item.text)) {
      await ctx.callTool(TOOL.setTaskStatus, { taskId: item.taskId, status: "ignored" });
      continue;
    }
    if (item.kind === "updated") {
      await ctx.callTool(TOOL.postComment, {
        taskId: item.taskId,
        text: "Noted the change.",
        summary: "Noted",
      });
      continue;
    }
    await ctx.callTool(TOOL.postComment, {
      taskId: item.taskId,
      text: `On it — ${lowerFirst(item.text)}.`,
      summary: "On it",
    });
    await ctx.callTool(TOOL.spawnSubagent, {
      taskId: item.taskId,
      goal: item.text,
      instructions: "Mock mode: simulate the work.",
      capabilities: ["web"],
    });
  }
}

async function mockSubagent(ctx: ScriptContext): Promise<void> {
  if (ctx.turn > 0) {
    await ctx.say(`Got it — ${excerpt(ctx.message)}`);
    await ctx.callTool(TOOL.finishTask, {
      status: "done",
      summary: "Updated based on your message. *(Mock mode — nothing real happened.)*",
      shortSummary: "Updated",
    });
    return;
  }
  const task = taskFromKickoff(ctx.message);
  await ctx.say(`Looking into “${task}” — gathering a few options first.`);
  await ctx.callTool(TOOL.postUpdate, {
    text: "Found a few good options; putting together a short summary.",
    summary: "Drafting summary",
  });
  await ctx.callTool(TOOL.createArtifact, {
    title: `Summary: ${task}`,
    kind: "markdown",
    content: mockArtifact(task),
  });
  const verb = riskyVerb(task);
  if (verb) {
    const outcome = await ctx.callTool(TOOL.mockIrreversibleAction, {
      action: verb,
      details: `${verb} for “${task}”`,
    });
    if (outcome.blocked || outcome.result.isError) {
      await ctx.callTool(TOOL.finishTask, {
        status: "needs_user",
        summary: `I prepared everything but didn't ${verb} because it wasn't approved (${toolResultText(outcome.result)}).`,
        shortSummary: "Not approved",
      });
      return;
    }
    await ctx.callTool(TOOL.finishTask, {
      status: "done",
      summary: `Done: ${verb} for “${task}”. See the summary artifact. *(Mock mode — nothing real happened.)*`,
      shortSummary: `Done · ${verb} (mock)`,
    });
    return;
  }
  await ctx.callTool(TOOL.finishTask, {
    status: "done",
    summary: `Here's a quick summary for “${task}” — details are in the artifact. *(Mock mode — nothing real happened.)*`,
    shortSummary: "Summary ready",
  });
}

function taskFromKickoff(message: string): string {
  const match = /^Task: ("(?:[^"\\]|\\.)*")/m.exec(message);
  if (match) {
    try {
      return JSON.parse(match[1]!) as string;
    } catch {
      // fall through
    }
  }
  return "your task";
}

function mockArtifact(task: string): string {
  return [
    `# ${task}`,
    "",
    "_Mock mode: this artifact was generated without any real research._",
    "",
    "## Options",
    "",
    "| Option | Why | Cost |",
    "| --- | --- | --- |",
    "| A | Best overall | $$ |",
    "| B | Cheapest | $ |",
    "| C | Fastest | $$$ |",
    "",
    "## Recommendation",
    "",
    "Option A balances quality and price.",
    "",
  ].join("\n");
}

function lowerFirst(text: string): string {
  return text.length > 1 && /^[A-Z][a-z]/.test(text)
    ? text[0]!.toLowerCase() + text.slice(1)
    : text;
}

function excerpt(text: string): string {
  const quoted = /"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? text;
  return quoted.length > 80 ? `${quoted.slice(0, 79)}…` : quoted;
}
