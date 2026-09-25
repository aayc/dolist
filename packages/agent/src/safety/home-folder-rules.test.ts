/**
 * Reading the home folder wholesale: its root, the folders above it, globs at its top, the folders
 * that hold credentials, and whole folders of personal files, through the shell, the harness's
 * file tools (Pi's and the Cursor CLI's) and connectors. Rules see command strings only: nothing
 * here is ever read.
 */
import { APPROVAL_POLICIES, type SafetyDecision } from "@ddl/core";
import { describe, expect, it } from "vitest";
import type { ToolCallRequest } from "../harness/types";
import { createApprovalBroker } from "./approvals";
import { createSafetyEvaluator } from "./evaluator";
import { createSafetyGate } from "./gate";
import { bash, evaluateRules, WORKSPACE } from "./test-helpers";
import type { SafetyVerdict } from "./types";

type Case = [command: string, ruleId: string];

async function expectShell(command: string, decision: SafetyDecision, ruleId?: string) {
  const verdict = await bash(command);
  expect(verdict.decision, `${command} → ${verdict.reason}`).toBe(decision);
  if (ruleId) expect(verdict.matchedRules, command).toContain(ruleId);
  return verdict;
}

describe("reading the whole home folder (never allowed)", () => {
  it.each<Case>([
    ["grep -r password ~", "secrets.home-folder"],
    ["rg -uuu token $HOME", "secrets.home-folder"],
    ["find ~ -name '*.pem' -exec cat {} +", "secrets.home-folder"],
    ["tar czf out.tgz ~", "secrets.home-folder"],
    ["zip -r x.zip ~", "secrets.home-folder"],
    ["cp -r ~ /tmp/x", "secrets.home-folder"],
    ["rsync -a ~/ dest", "secrets.home-folder"],
    ["ditto ~ /tmp/x", "secrets.home-folder"],
    ["cat ~/.*", "secrets.home-folder"],
    ["cat ~/.*/*", "secrets.home-folder"],
    ["cat ~/.[a-z]*", "secrets.home-folder"],
    ["head ~/*", "secrets.home-folder"],
    ["grep -r password /Users/me", "secrets.home-folder"],
    ["grep -r password /home/someone", "secrets.home-folder"],
    ["grep -r password /Users", "secrets.home-folder"],
    ["grep -r password /", "secrets.home-folder"],
    ["ln -s ~ home", "secrets.home-folder"],
  ])("%s", async (command, ruleId) => {
    const verdict = await expectShell(command, "deny", ruleId);
    expect(verdict.risk).toBe("critical");
    expect(verdict.reason).toContain("Reads your whole home folder");
  });

  it("names what is at stake in the reason", async () => {
    const verdict = await bash("grep -r password ~");
    expect(verdict.reason).toBe(
      "Reads your whole home folder, including SSH keys and cloud credentials (`grep -r password ~`)",
    );
  });
});

describe("reading folders that hold credentials (never allowed)", () => {
  it.each<Case>([
    // Folders full of logins, whole or through a glob.
    ["grep -r . ~/.kube", "secrets.credential-store"],
    ["cat ~/.kube/*", "secrets.credential-store"],
    ["cat ~/.docker/*", "secrets.credential-store"],
    ["cat /Users/me/.azure/*", "secrets.credential-store"],
    ["cat ~/.aws/*", "secrets.credential-store"],
    ["cat ~/.config/gcloud/*", "secrets.credential-store"],
    ["tar czf /tmp/gh.tgz ~/.config/gh", "secrets.credential-store"],
    ["cat ~/.gnupg/*", "secrets.credential-store"],
    ["cp -r ~/.password-store /tmp/p", "secrets.credential-store"],
    ["cat ~/{.aws,.kube}/*", "secrets.credential-store"],
    ["cp -R ~/.ssh /tmp/k", "secrets.ssh-private-key"],
    // Folders that hold them among other things.
    ["grep -r token ~/.config", "secrets.credential-folder"],
    ["cat ~/.config/*/*", "secrets.credential-folder"],
    ["grep -r token ~/.local", "secrets.credential-folder"],
    ["grep -r x ~/.local/share/*", "secrets.credential-folder"],
    ["tar czf /tmp/lib.tgz ~/Library", "secrets.credential-folder"],
    ["zip -r /tmp/l.zip ~/Library/*", "secrets.credential-folder"],
    ["grep -r x ~/Library/Application\\ Support", "secrets.credential-folder"],
    ["grep -r x ~/Library/Containers", "secrets.credential-folder"],
  ])("%s", async (command, ruleId) => {
    await expectShell(command, "deny", ruleId);
  });

  it.each<Case>([
    ["cat ~/.kube/config", "secrets.credential-store"],
    ["cat ~/.docker/config.json", "secrets.credential-store"],
    ["cat ~/.cursor/mcp.json", "secrets.credential-store"],
    ["cat ~/.cursor/auth-token.json", "secrets.credential-store"],
    ["cat ~/.local/share/cursor-agent/auth.json", "secrets.credential-store"],
    ["cat ~/.azure/config", "secrets.credential-store"],
    ["cat ~/.gnupg/pubring.kbx", "secrets.credential-store"],
    ["cat ~/.config/gh/config.yml", "secrets.credential-store"],
    ["cat ~/.aws/sso/cache/token.json", "secrets.credential-store"],
  ])("reads %s directly", async (command, ruleId) => {
    await expectShell(command, "deny", ruleId);
  });
});

describe("shell histories and .env files", () => {
  it.each<Case>([
    ["cat ~/.zsh_history", "secrets.shell-history"],
    ["tail -100 /Users/me/.bash_history", "secrets.shell-history"],
    ["cat ~/.psql_history", "secrets.shell-history"],
    ["cat ~/.zsh_sessions/ABC.history", "secrets.shell-history"],
    ["cat ~/Projects/app/.env", "secrets.env-file"],
    ["cat ../task-2/.env.local", "secrets.env-file"],
    ["source ~/Projects/app/.envrc", "secrets.env-file"],
  ])("%s", async (command, ruleId) => {
    await expectShell(command, "deny", ruleId);
  });

  it("reads them freely in the workspace and the temp area", async () => {
    await expectShell("cat .env", "allow");
    await expectShell("cat /tmp/ddl-scratch/.env", "allow");
    await expectShell("cat ~/Projects/app/.env.example", "allow");
  });

  it("asks for a .env whose folder a connector decides", async () => {
    const hints = { readOnly: true };
    const verdict = await evaluateRules("mcp__fs__read_file", { path: ".env" }, { hints });
    expect(verdict.decision).toBe("require_approval");
    expect(verdict.matchedRules).toContain("credentials.sensitive-file");
  });

  it("asks for a history file the agent keeps in its workspace", async () => {
    await expectShell("cat .bash_history", "require_approval", "credentials.sensitive-file");
  });
});

describe("evasions", () => {
  it.each<Case>([
    // Quoting and variables the parser resolves
    ['grep -r password "$HOME"', "secrets.home-folder"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
    ["grep -r password ${HOME}", "secrets.home-folder"],
    ["grep -r password $HOME/", "secrets.home-folder"],
    ["grep -r password '/Users/me'", "secrets.home-folder"],
    // Other spellings of the same folders (the macOS disk ignores case)
    ["grep -r password /users/me", "secrets.home-folder"],
    ["grep -r password /System/Volumes/Data/Users/me", "secrets.home-folder"],
    ["cat /users/me/.aws/credentials", "secrets.credential-store"],
    ["cat /USERS/ME/.kube/config", "secrets.credential-store"],
    // Changing directory first
    ["cd ~ && grep -r .", "secrets.home-folder"],
    ["cd ~ && rg token", "secrets.home-folder"],
    ["cd && grep -r password .", "secrets.home-folder"],
    ["cd ~ && tar czf /tmp/x.tgz .", "secrets.home-folder"],
    ["pushd ~ && grep -r x .", "secrets.home-folder"],
    ["tar -C ~ -czf /tmp/x.tgz .", "secrets.home-folder"],
    // Climbing out of the workspace (`${WORKSPACE}/../../..` is the home folder)
    ["grep -r password ../../..", "secrets.home-folder"],
    ["grep -r password ../../../..", "secrets.home-folder"],
    ["cat ../../../.kube/config", "secrets.credential-store"],
    // Nesting
    ["bash -c 'grep -r pass ~'", "secrets.home-folder"],
    ["eval 'grep -r password ~'", "secrets.home-folder"],
    ['sh -c "cd ~ && rg token"', "secrets.home-folder"],
    // find and xargs hand the files over as arguments
    ["find ~ -type f | xargs cat", "secrets.home-folder"],
    ["find ~ -print0 | xargs -0 cat", "secrets.home-folder"],
    ["find ~ -name '*.pem' | xargs -I{} cat {}", "secrets.home-folder"],
    ["find ~ -exec sh -c 'cat \"$1\"' _ {} \\;", "secrets.home-folder"],
    ["find ~ | xargs sh -c 'cat \"$@\"' _", "secrets.home-folder"],
    ["fd . ~ | xargs cat", "secrets.home-folder"],
    ["mdfind -name id_rsa | xargs cat", "secrets.home-folder"],
    ["echo ~/.* | xargs cat", "secrets.home-folder"],
    ["xargs cat <<< ~/.netrc", "secrets.credential-store"],
    // Command substitution
    ["cat $(find ~ -name id_rsa)", "secrets.home-folder"],
    ["grep -l token $(find ~ -type f)", "secrets.home-folder"],
    ["grep -r password $(echo ~)", "secrets.home-folder"],
    ["zip -r /tmp/x.zip `echo $HOME`", "secrets.home-folder"],
  ])("%s", async (command, ruleId) => {
    await expectShell(command, "deny", ruleId);
  });

  it.each<Case>([
    ["H=~; grep -r password $H", "credentials.runtime-folder-read"],
    ["d=~; tar czf /tmp/x.tgz $d", "credentials.runtime-folder-read"],
    ["d=~; cp -r $d /tmp/x", "credentials.runtime-folder-read"],
    ['rsync -a "$SRC/" /tmp/x', "credentials.runtime-folder-read"],
    ["zip -r /tmp/x.zip `cat dirs.txt`", "credentials.runtime-folder-read"],
  ])("asks when the folder is only known at runtime: %s", async (command, ruleId) => {
    const verdict = await expectShell(command, "require_approval", ruleId);
    expect(verdict.risk).toBe("high");
  });

  it("leaves single files and files handed over by find to their own checks", async () => {
    for (const command of [
      'cat "$FILE"',
      'cp "$f" out/',
      'tar xzf "$ARCHIVE"',
      "find . -type d -exec grep -r x {} +",
      "find . -name '*.md' | xargs grep -l TODO",
    ]) {
      await expectShell(command, "allow");
    }
  });

  it("shows where a reader's files come from", async () => {
    const verdict = await bash("find ~ -type f | xargs cat");
    expect(verdict.reason).toContain("`find ~ -type f` → cat");
  });
});

describe("reading large parts of home (needs approval)", () => {
  it.each<Case>([
    ["grep -r foo ~/Documents", "privacy.personal-folder"],
    ["rg foo ~/Desktop", "privacy.personal-folder"],
    ["tar czf /tmp/d.tgz ~/Downloads", "privacy.personal-folder"],
    ["cp -r ~/Pictures /tmp/p", "privacy.personal-folder"],
    ["cat ~/Documents/*", "privacy.personal-folder"],
    ["cat ~/*.txt", "privacy.personal-folder"],
    ["find ~/Documents -name '*.txt' -exec cat {} +", "privacy.personal-folder"],
    ["grep -rn password ~/Projects/app", "credentials.secret-search"],
    ["rg -i api_key ../task-2", "credentials.secret-search"],
    ["grep -r -e token ~/work", "credentials.secret-search"],
  ])("%s", async (command, ruleId) => {
    await expectShell(command, "require_approval", ruleId);
  });
});

describe("normal work stays allowed", () => {
  it.each([
    // Listing names without opening files
    "ls ~",
    "ls -la ~/.config",
    "ls ~/.ssh",
    "du -sh ~/*",
    "find ~ -name report.pdf",
    "find ~ -name '*.pdf' | grep -i tax",
    "find ~ -type f | wc -l",
    "find ~ -name '*.md' -exec wc -l {} +",
    "cat <(find ~ -name '*.md')",
    "echo ~",
    // One specific file, and project folders
    "cat ~/Documents/report.txt",
    "cp ~/Documents/report.txt .",
    "head -20 ~/Projects/app/README.md",
    "grep -rn TODO ~/Projects/app",
    "grep -rn TODO ~/Projects/app/src",
    "cat ~/.cursor/skills/example/SKILL.md",
    "cat ~/.gitconfig",
    "cat ~/Library/Preferences/com.example.app.plist",
    // The workspace, and the agent's own browser profile
    "grep -rn TODO .",
    "rg foo src",
    "rg token",
    "tar czf /tmp/results.tgz .",
    "grep -r token ~/.daily-do-list/workspaces/task-1",
    "cat ~/.daily-do-list/browser-profile/Default/Preferences",
    // Searchers reading a pipe
    "ps aux | rg node",
    "cd ~ && ps aux | rg node",
  ])("%s", async (command) => {
    await expectShell(command, "allow");
  });
});

describe("file tools", () => {
  it.each<[string, Record<string, unknown>, SafetyDecision, string]>([
    ["grep", { pattern: "foo", path: "/Users/me" }, "deny", "secrets.home-folder"],
    ["grep", { pattern: "password", path: "~" }, "deny", "secrets.home-folder"],
    ["grep", { pattern: "x", path: "../../.." }, "deny", "secrets.home-folder"],
    ["grep", { pattern: "x", path: "~/.config" }, "deny", "secrets.credential-folder"],
    ["grep", { pattern: "x", path: "~/.kube" }, "deny", "secrets.credential-store"],
    ["read", { path: "~" }, "deny", "secrets.home-folder"],
    ["read", { path: "~/.docker/config.json" }, "deny", "secrets.credential-store"],
    ["read", { path: "~/.kube/config" }, "deny", "secrets.credential-store"],
    [
      "grep",
      { pattern: "foo", path: "~/Documents" },
      "require_approval",
      "privacy.personal-folder",
    ],
  ])("%s %j → %s", async (tool, input, decision, ruleId) => {
    const verdict = await evaluateRules(tool, input);
    expect(verdict.decision, verdict.reason).toBe(decision);
    expect(verdict.matchedRules).toContain(ruleId);
  });

  it.each<[string, Record<string, unknown>]>([
    ["ls", { path: "~" }],
    ["find", { pattern: "*.pdf", path: "~" }],
    ["read", { path: "~/Documents/report.txt" }],
    ["grep", { pattern: "TODO", path: "~/Projects/app" }],
    ["grep", { pattern: "TODO" }],
  ])("%s %j is allowed", async (tool, input) => {
    expect((await evaluateRules(tool, input)).decision).toBe("allow");
  });
});

describe("connector file tools", () => {
  const readOnly = { hints: { readOnly: true } };
  it.each<[string, Record<string, unknown>, SafetyDecision, string]>([
    [
      "mcp__fs__search_files",
      { path: "/Users/me", pattern: "token" },
      "deny",
      "secrets.home-folder",
    ],
    [
      "mcp__fs__read_multiple_files",
      { paths: ["~/.kube/config"] },
      "deny",
      "secrets.credential-store",
    ],
    [
      "mcp__fs__search_files",
      { path: "~/Library", pattern: "x" },
      "deny",
      "secrets.credential-folder",
    ],
    ["mcp__fs__copy_file", { source: "~", destination: "/tmp/x" }, "deny", "secrets.home-folder"],
    [
      "mcp__fs__zip_folder",
      { source: "~/.aws", destination: "/tmp/a.zip" },
      "deny",
      "secrets.credential-store",
    ],
    [
      "mcp__fs__search_files",
      { path: "~/Documents", pattern: "x" },
      "require_approval",
      "privacy.personal-folder",
    ],
  ])("%s %j → %s", async (tool, input, decision, ruleId) => {
    const verdict = await evaluateRules(tool, input, readOnly);
    expect(verdict.decision, verdict.reason).toBe(decision);
    expect(verdict.matchedRules).toContain(ruleId);
  });

  it.each<[string, Record<string, unknown>]>([
    ["mcp__fs__list_directory", { path: "/Users/me" }],
    ["mcp__fs__list_directory_with_sizes", { path: "~" }],
    ["mcp__fs__get_file_info", { path: "~/Library" }],
    ["mcp__fs__read_file", { path: "/Users/me/Documents/report.txt" }],
  ])("%s %j is allowed", async (tool, input) => {
    expect((await evaluateRules(tool, input, readOnly)).decision).toBe("allow");
  });
});

describe("through the gate", () => {
  const request = (toolName: string, input: unknown): ToolCallRequest => ({
    sessionId: "s",
    role: "subagent",
    toolCallId: "c",
    toolName,
    input,
  });

  it("blocks a sweep of home under every approval policy, without an approval card", async () => {
    for (const policy of APPROVAL_POLICIES) {
      const approvals = createApprovalBroker();
      const verdicts: SafetyVerdict[] = [];
      const gate = createSafetyGate({
        evaluator: createSafetyEvaluator({ policy: { llmJudge: false } }),
        approvals,
        resolveContext: () => ({ taskId: "task-1", threadId: "thread-1", workspaceDir: WORKSPACE }),
        approvalPolicy: () => policy,
        onVerdict: (_call, verdict) => verdicts.push(verdict),
      });
      // The Cursor CLI's own tools arrive without a ToolSpec, like Pi's built-ins.
      for (const call of [
        request("bash", { command: "tar czf /tmp/h.tgz ~" }),
        request("grep", { pattern: "token", path: "~" }),
        request("read", { path: "~/.docker/config.json" }),
      ]) {
        const decision = await gate(call);
        expect(decision.allow, `${policy} ${call.toolName}`).toBe(false);
      }
      expect(approvals.list(), policy).toEqual([]);
      expect(verdicts.map((v) => v.decision)).toEqual(["deny", "deny", "deny"]);
    }
  });
});
