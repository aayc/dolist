import { describe, expect, it } from "vitest";
import { evaluateRules, WORKSPACE } from "./test-helpers";

async function expectDecision(toolName: string, input: unknown, decision: string, ruleId?: string) {
  const verdict = await evaluateRules(toolName, input);
  expect(verdict.decision, `${toolName} ${JSON.stringify(input)} → ${verdict.reason}`).toBe(
    decision,
  );
  if (ruleId) expect(verdict.matchedRules).toContain(ruleId);
  return verdict;
}

describe("MCP connector tools", () => {
  it.each([
    [
      "mcp__gmail__send_email",
      { to: "a@example.com", subject: "Hi", body: "Hello" },
      "mcp.communication-action",
    ],
    ["mcp__gmail__reply_to_thread", { threadId: "t1", body: "Thanks" }, "mcp.communication-action"],
    ["mcp__slack__slack_post_message", { channel: "C1", text: "hi" }, "mcp.communication-action"],
    ["mcp__slack__chat_postMessage", { channel: "C1", text: "hi" }, "mcp.communication-action"],
    ["mcp__twilio__message_user", { to: "+15550100199", body: "hi" }, "mcp.communication-action"],
    [
      "mcp__google_calendar__create_event",
      { summary: "Dentist", start: "2026-10-01T09:30" },
      "mcp.booking-action",
    ],
    [
      "mcp__google_calendar__respond_to_event",
      { eventId: "e1", response: "accepted" },
      "mcp.booking-action",
    ],
    ["mcp__opentable__book_table", { restaurant: "r1", party: 2 }, "mcp.booking-action"],
    ["mcp__stripe__create_payment_intent", { amount: 4200, currency: "usd" }, "mcp.payment-action"],
    ["mcp__shop__place_order", { items: ["sku-1"] }, "mcp.payment-action"],
    ["mcp__github__create_issue", { repo: "o/r", title: "Bug" }, "mcp.publishing-action"],
    ["mcp__github__github_push_files", { repo: "o/r", files: [] }, "mcp.publishing-action"],
    ["mcp__github__merge_pull_request", { repo: "o/r", number: 1 }, "mcp.publishing-action"],
    ["mcp__notion__update_page", { pageId: "p1", content: "x" }, "mcp.publishing-action"],
    ["mcp__github__add_collaborator", { repo: "o/r", user: "sam" }, "mcp.account-action"],
    ["mcp__gdrive__delete_file", { fileId: "f1" }, "mcp.destructive-action"],
    ["mcp__terminal__execute_command", { command: "ls" }, "mcp.system-action"],
    ["mcp__postgres__query", { sql: "DROP TABLE users;" }, "destructive.sql"],
  ])("%s needs approval (%s)", async (tool, input, ruleId) => {
    await expectDecision(tool, input, "require_approval", ruleId);
  });

  it("adds communication when an effectful tool has recipients and payment when it has an amount", async () => {
    const invite = await expectDecision(
      "mcp__google_calendar__create_event",
      { summary: "Sync", attendees: ["b@example.com"] },
      "require_approval",
    );
    expect(invite.categories).toEqual(expect.arrayContaining(["booking", "communication"]));
    const invoice = await expectDecision(
      "mcp__billing__create_invoice",
      { customer: "c1", amount: 100 },
      "require_approval",
    );
    expect(invoice.categories).toContain("payment");
  });

  it.each([
    ["mcp__gmail__search_threads", { query: "from:bank" }, "mcp.read-action"],
    ["mcp__gmail__get_message", { id: "m1" }, "mcp.read-action"],
    [
      "mcp__gmail__create_draft",
      { to: "a@example.com", subject: "Hi", body: "Draft" },
      "mcp.draft",
    ],
    ["mcp__google_calendar__list_events", { timeMin: "2026-10-01" }, "mcp.read-action"],
    ["mcp__github__list_issues", { repo: "o/r" }, "mcp.read-action"],
    ["mcp__github__get_pull_request_comments", { repo: "o/r", number: 3 }, "mcp.read-action"],
    ["mcp__shop__get_order", { id: "o1" }, "mcp.read-action"],
    ["mcp__stripe__list_charges", { limit: 10 }, "mcp.read-action"],
    ["mcp__postgres__query", { sql: "SELECT count(*) FROM users" }, "mcp.read-action"],
  ])("%s is allowed (%s)", async (tool, input, ruleId) => {
    await expectDecision(tool, input, "allow", ruleId);
  });

  it("does not let a readOnly annotation hide a risky verb", async () => {
    const verdict = await evaluateRules(
      "mcp__mail__send_email",
      { to: "a@example.com" },
      { hints: { readOnly: true } },
    );
    expect(verdict.decision).toBe("require_approval");
  });

  it("allows unknown-verb tools that are annotated read-only, and asks otherwise", async () => {
    expect(
      (
        await evaluateRules(
          "mcp__weather__forecast",
          { city: "Lisbon" },
          { hints: { readOnly: true } },
        )
      ).decision,
    ).toBe("allow");
    const unknown = await evaluateRules("mcp__weather__forecast", { city: "Lisbon" });
    expect(unknown.decision).toBe("require_approval");
    expect(unknown.source).toBe("fallback");
  });

  it("uses the tool's category hint and destructive hint", async () => {
    const hinted = await evaluateRules(
      "mcp__crm__sync",
      {},
      { hints: { readOnly: true, category: "communication" } },
    );
    expect(hinted.decision).toBe("require_approval");
    const destructive = await evaluateRules(
      "mcp__crm__lookup",
      { id: 1 },
      { hints: { destructive: true } },
    );
    expect(destructive.decision).toBe("require_approval");
    expect(destructive.categories).toContain("destructive");
  });

  it("checks card numbers, secrets and URLs inside connector arguments", async () => {
    await expectDecision(
      "mcp__notes__search",
      { query: "card 4111 1111 1111 1111" },
      "require_approval",
      "payment.card-number",
    );
    await expectDecision(
      "mcp__web__get_page",
      { url: "http://192.168.0.1/" },
      "require_approval",
      "network.local-address",
    );
    await expectDecision(
      "mcp__fs__read_file",
      { path: "/Users/me/.ssh/id_rsa" },
      "deny",
      "secrets.ssh-private-key",
    );
    await expectDecision(
      "mcp__fs__write_file",
      { path: "notes.md", content: "x" },
      "require_approval",
      "file_write.outside-workspace",
    );
  });
});

describe("file tools", () => {
  it.each([
    ["read", { path: "~/.ssh/id_ed25519" }, "deny", "secrets.ssh-private-key"],
    ["read", { path: "/Users/me/.aws/credentials" }, "deny", "secrets.credential-store"],
    ["read", { path: "@~/.daily-do-list/.env" }, "deny", "secrets.credential-store"],
    ["grep", { pattern: "BEGIN", path: "~/.ssh" }, "deny", "secrets.ssh-private-key"],
    ["read", { path: "/Users/me/work/app/.env" }, "deny", "secrets.env-file"],
    ["read", { path: "~/.bash_history" }, "deny", "secrets.shell-history"],
    ["read", { path: "~/.npmrc" }, "require_approval", "credentials.sensitive-file"],
    ["read", { path: "~/Library/Messages/chat.db" }, "require_approval", "privacy.personal-data"],
    [
      "grep",
      { pattern: "password", path: "/Users/me/projects" },
      "require_approval",
      "credentials.secret-search",
    ],
    [
      "write",
      { path: "~/.zshrc", content: "alias ll='ls -l'" },
      "require_approval",
      "system.persistence-write",
    ],
    [
      "edit",
      { path: "/Users/me/.ssh/config", edits: [{ oldText: "a", newText: "b" }] },
      "require_approval",
      "system.persistence-write",
    ],
    [
      "write",
      { path: "/Users/me/Vault/Daily/2026-09-23.md", content: "- [ ] x" },
      "require_approval",
      "file_write.note-edit",
    ],
    [
      "write",
      { path: "/Users/me/Desktop/out.txt", content: "x" },
      "require_approval",
      "file_write.outside-workspace",
    ],
    [
      "write",
      { path: "../task-2/notes.txt", content: "x" },
      "require_approval",
      "file_write.outside-workspace",
    ],
    [
      "write",
      { path: "../task-2/notes.md", content: "x" },
      "require_approval",
      "file_write.note-edit",
    ],
    [
      "write",
      { path: "/etc/hosts", content: "0.0.0.0 x" },
      "require_approval",
      "system.persistence-write",
    ],
    [
      "write",
      { path: "/usr/local/bin/tool", content: "#!/bin/sh" },
      "require_approval",
      "system.system-path-write",
    ],
    [
      "write",
      { path: "/Users/me/Vault/.daily-do-list/state/approvals.json", content: "{}" },
      "deny",
      "secrets.app-config-write",
    ],
    [
      "write",
      { path: "~/.daily-do-list/mcp.json", content: "{}" },
      "deny",
      "secrets.app-config-write",
    ],
    [
      "write",
      { path: "cleanup.sh", content: "#!/bin/sh\nrm -rf ~/\n" },
      "require_approval",
      "system.code-hazard-write",
    ],
    [
      "write",
      { path: "steal.py", content: "open(os.path.expanduser('~/.ssh/id_rsa')).read()" },
      "require_approval",
      "system.code-hazard-write",
    ],
  ])("%s %j → %s", async (tool, input, decision, ruleId) => {
    await expectDecision(tool, input, decision, ruleId);
  });

  it.each([
    ["read", { path: "notes/plan.md" }, "files.read"],
    ["read", { path: `${WORKSPACE}/data.csv` }, "files.read"],
    ["read", { path: ".env" }, "files.read"],
    ["grep", { pattern: "TODO" }, "files.read"],
    ["ls", { path: "~/.ssh" }, "files.read"],
    ["find", { pattern: "*.pem", path: "~" }, "files.read"],
    ["write", { path: "notes/summary.md", content: "# Summary" }, "file_write.workspace"],
    [
      "edit",
      { path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] },
      "file_write.workspace",
    ],
    ["write", { path: "/tmp/ddl-scratch/out.json", content: "{}" }, "file_write.workspace"],
  ])("%s %j is allowed", async (tool, input, ruleId) => {
    await expectDecision(tool, input, "allow", ruleId);
  });

  it("fails closed when the workspace is unknown", async () => {
    const verdict = await evaluateRules(
      "write",
      { path: "notes.md", content: "x" },
      { workspaceDir: undefined },
    );
    expect(verdict.decision).toBe("require_approval");
  });
});
