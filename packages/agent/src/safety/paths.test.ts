import { describe, expect, it } from "vitest";
import {
  catastrophicTarget,
  cleanPathInput,
  expandBraces,
  inferHome,
  initialCwd,
  isUserDataPath,
  resolvePath,
  sensitiveKinds,
} from "./paths";
import { WORKSPACE } from "./test-helpers";

const cwd = initialCwd(WORKSPACE);

describe("resolvePath", () => {
  it.each([
    ["notes.md", "workspace", `${WORKSPACE}/notes.md`],
    ["./out/a.txt", "workspace", `${WORKSPACE}/out/a.txt`],
    ["../task-2/x", "outside", "/Users/me/.daily-do-list/workspaces/task-2/x"],
    ["~/Documents/a.txt", "outside", "/Users/me/Documents/a.txt"],
    [`${WORKSPACE}/deep/../file`, "workspace", `${WORKSPACE}/file`],
    ["/tmp/scratch/x.json", "temp", "/tmp/scratch/x.json"],
    ["/tmp", "outside", "/tmp"],
    ["/tmp/*", "outside", "/tmp/*"],
    ["/etc/hosts", "outside", "/etc/hosts"],
    [`file://${WORKSPACE}/a%20b.txt`, "workspace", `${WORKSPACE}/a b.txt`],
    ["@~/.zshrc", "outside", "/Users/me/.zshrc"],
  ])("%s → %s", (raw, location, path) => {
    expect(resolvePath(raw, cwd, WORKSPACE)).toEqual({ location, path });
  });

  it("treats relative paths as unknown when the working directory is unknown", () => {
    expect(resolvePath("notes.md", { kind: "unknown" }, WORKSPACE).location).toBe("unknown");
    expect(resolvePath("notes.md", initialCwd(undefined)).location).toBe("unknown");
  });

  it("keeps ~ symbolic when the home directory cannot be inferred", () => {
    expect(resolvePath("~/a/../b", initialCwd("/srv/ws"), "/srv/ws")).toEqual({
      location: "outside",
      path: "~/b",
    });
    expect(resolvePath("~/..", initialCwd("/srv/ws"), "/srv/ws").path).toBe("~/..");
  });

  it("infers the home directory from the workspace path", () => {
    expect(inferHome(WORKSPACE)).toBe("/Users/me");
    expect(inferHome("/home/user/ws")).toBe("/home/user");
    expect(inferHome("/srv/ws")).toBeUndefined();
  });

  it("undoes file tool path spellings", () => {
    expect(cleanPathInput("@notes.md")).toBe("notes.md");
    expect(cleanPathInput("file:///tmp/a%20b")).toBe("/tmp/a b");
    expect(cleanPathInput("a\u00A0b")).toBe("a b");
  });
});

describe("sensitiveKinds", () => {
  it.each([
    ["/Users/me/.ssh/id_rsa", "ssh-private-key"],
    ["~/.ssh/id_ed25519", "ssh-private-key"],
    ["~/.ssh", "ssh-private-key"],
    ["~/.ssh/*", "ssh-private-key"],
    ["~/.aws/credentials", "credential-store"],
    ["~/Library/Keychains/login.keychain-db", "credential-store"],
    ["/Users/me/Library/Application Support/Google/Chrome/Default/Login Data", "credential-store"],
    ["~/.daily-do-list/.env", "app-secret"],
    ["/vault/.daily-do-list/state/approvals.json", "app-state"],
    ["/work/app/.env.local", "env-file"],
    ["/work/certs/server.pem", "key-material"],
    ["~/.npmrc", "credential-config"],
    ["~/.zsh_history", "history"],
    ["~/Library/Messages/chat.db", "personal-data"],
    ["~/.zshrc", "shell-startup"],
    ["~/Library/LaunchAgents/com.example.plist", "persistence"],
    ["~/.ssh/authorized_keys", "persistence"],
    ["/etc/sudoers", "persistence"],
    ["/usr/local/bin/tool", "system"],
  ])("%s is %s", (path, kind) => {
    expect(sensitiveKinds(path).has(kind as never)).toBe(true);
  });

  it("does not flag public keys, env templates or ordinary files", () => {
    expect(sensitiveKinds("~/.ssh/id_ed25519.pub").has("ssh-private-key")).toBe(false);
    expect(sensitiveKinds("/work/app/.env.example").size).toBe(0);
    expect(sensitiveKinds("/Users/me/Documents/report.pdf").size).toBe(0);
  });
});

describe("catastrophicTarget", () => {
  it.each([
    ["/", "root"],
    ["/*", "root"],
    ["/.", "root"],
    ["/usr", "system"],
    ["/System/", "system"],
    ["/etc/*", "system"],
    ["/u*", "system"],
    ["/Users", "system"],
    ["/Users/*", "system"],
    ["/home/u*", "home"],
    ["~", "home"],
    ["~/..", "system"],
    ["/Users/me", "home"],
    ["/home/user/*", "home"],
  ])("%s → %s", (path, kind) => {
    expect(catastrophicTarget(path)).toBe(kind);
  });

  it.each(["/tmp/build", "/Users/me/project/build", "~/project", "/usr/local/lib/node_modules/x"])(
    "%s is not catastrophic",
    (path) => {
      expect(catastrophicTarget(path)).toBeNull();
    },
  );

  it("recognizes the inferred home directory", () => {
    expect(catastrophicTarget("/Users/me", "/Users/me")).toBe("home");
  });
});

describe("helpers", () => {
  it("expands simple brace lists", () => {
    expect(expandBraces("/{usr,etc}")).toEqual(["/usr", "/etc"]);
    expect(expandBraces("a{1,2}b{x,y}")).toEqual(["a1bx", "a1by", "a2bx", "a2by"]);
    expect(expandBraces("plain")).toEqual(["plain"]);
  });

  it("knows the folders users care most about", () => {
    expect(isUserDataPath("/Users/me/Documents/taxes")).toBe(true);
    expect(isUserDataPath("~/Desktop")).toBe(true);
    expect(isUserDataPath("/Users/me/.cache/x")).toBe(false);
  });
});
