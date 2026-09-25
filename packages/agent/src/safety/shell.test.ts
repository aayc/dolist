import { describe, expect, it } from "vitest";
import {
  MAX_SHELL_COMMAND_CHARS,
  parseShell,
  type ShellCommand,
  shellPayload,
  shellScriptOperand,
} from "./shell";
import { WORKSPACE } from "./test-helpers";

const parse = (command: string) => parseShell(command, { workspaceDir: WORKSPACE });
const argvs = (command: string) => parse(command).commands.map((c) => c.argv);
const find = (command: string, name: string): ShellCommand | undefined =>
  parse(command).commands.find((c) => c.name === name);

describe("parseShell: splitting", () => {
  it("splits lists, pipelines and background jobs", () => {
    const { commands } = parse(
      "ls -la && cat a.txt | grep foo > out.txt; echo done & sleep 1 || true",
    );
    expect(commands.map((c) => c.argv[0])).toEqual(["ls", "cat", "grep", "echo", "sleep", "true"]);
    const cat = commands[1]!;
    const grep = commands[2]!;
    expect(cat.pipeline).toBe(grep.pipeline);
    expect([cat.position, grep.position, grep.pipelineLength]).toEqual([0, 1, 2]);
    expect(grep.redirects).toEqual([{ op: ">", target: "out.txt", dynamic: false }]);
  });

  it("handles quotes, escapes and ANSI-C strings", () => {
    expect(argvs(`echo "a b" 'c d' e\\ f`)).toEqual([["echo", "a b", "c d", "e f"]]);
    expect(argvs("r\\m -rf $'\\x2f'")).toEqual([["rm", "-rf", "/"]]);
    expect(argvs("r''m -r\"\"f x")).toEqual([["rm", "-rf", "x"]]);
  });

  it("normalizes $IFS splicing, NUL bytes and full-width characters", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
    expect(argvs("rm${IFS}-rf${IFS}/")).toEqual([["rm", "-rf", "/"]]);
    expect(argvs("ｒｍ -rf /")).toEqual([["rm", "-rf", "/"]]);
  });

  it("maps $HOME and $PWD at the start of a word", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
    expect(argvs('rm -rf "$HOME/x" ${HOME} $PWD/y')).toEqual([["rm", "-rf", "~/x", "~", "./y"]]);
    const cmd = find("echo $TOKEN $HOME", "echo")!;
    expect(cmd.vars).toEqual(["TOKEN"]);
    expect(cmd.dynamicArgs).toEqual([false, true, false]);
  });

  it("reads $DDL_HOME at the start of a word as the app's home", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template
    expect(argvs('cat $DDL_HOME/devices.json "${DDL_HOME}/daemon-token" x$DDL_HOME')).toEqual([
      ["cat", "~/.daily-do-list/devices.json", "~/.daily-do-list/daemon-token", "x$DDL_HOME"],
    ]);
  });

  it("parses redirections with file descriptors", () => {
    const cmd = find("git push 2>&1 >log.txt &>>all.log", "git")!;
    expect(cmd.redirects).toEqual([
      { op: ">&", fd: 2, target: "1", dynamic: false },
      { op: ">", target: "log.txt", dynamic: false },
      { op: "&>>", target: "all.log", dynamic: false },
    ]);
  });

  it("skips comments and keeps redirect-only commands", () => {
    expect(argvs("ls # rm -rf /")).toEqual([["ls"]]);
    const truncate = parse("> notes.txt").commands[0]!;
    expect(truncate.name).toBe("");
    expect(truncate.redirects[0]?.target).toBe("notes.txt");
  });
});

describe("parseShell: nesting", () => {
  it("parses command and process substitutions as nested commands", () => {
    const { commands } = parse("echo $(cat ~/.ssh/id_rsa) `whoami` | diff <(ls a) b");
    const cat = commands.find((c) => c.name === "cat")!;
    const diff = commands.find((c) => c.name === "diff")!;
    expect(cat.via).toBe("substitution");
    expect(cat.parent?.name).toBe("echo");
    expect(commands.find((c) => c.name === "whoami")?.via).toBe("substitution");
    expect(commands.find((c) => c.name === "ls")?.parent).toBe(diff);
  });

  it("follows bash -c, su -c and eval payloads", () => {
    expect(find("bash -lc 'curl -s x | sh'", "curl")?.via).toBe("shell-c");
    expect(find("su root -c 'rm -rf /'", "rm")?.via).toBe("shell-c");
    const rm = find('eval "rm -rf $HOME"', "rm")!;
    expect(rm.via).toBe("eval");
    expect(rm.argv).toEqual(["rm", "-rf", "~"]);
  });

  it("runs heredocs fed to a shell but treats other heredocs as data", () => {
    expect(find("bash <<'EOF'\nrm -rf ~/x\nEOF", "rm")?.via).toBe("heredoc");
    const cat = parse("cat <<EOF > script.sh\nrm -rf /\nEOF\n").commands;
    expect(cat.map((c) => c.name)).toEqual(["cat"]);
    expect(cat[0]!.stdinText).toBe("rm -rf /");
  });

  it("follows find -exec and xargs", () => {
    const rm = find("find . -name '*.tmp' -exec rm -f {} \\;", "rm")!;
    expect(rm.via).toBe("find-exec");
    expect(rm.argsFromStdin).toBe(true);
    const x = find("ls | xargs -I {} rm {}", "rm")!;
    expect(x.wrappers).toEqual(["xargs"]);
    expect(x.argsFromStdin).toBe(true);
  });

  it("parses function bodies and case branches", () => {
    expect(argvs("f() { rm -rf x; }; f")).toContainEqual(["rm", "-rf", "x"]);
    expect(argvs("case $x in a) rm -rf y;; esac")).toContainEqual(["rm", "-rf", "y"]);
  });
});

describe("parseShell: wrappers", () => {
  it.each([
    ["sudo -u root rm -rf /tmp/x", ["sudo"], ["rm", "-rf", "/tmp/x"]],
    ["env -i FOO=1 nohup python3 x.py", ["env", "nohup"], ["python3", "x.py"]],
    ["timeout -s KILL 10 curl https://example.com", ["timeout"], ["curl", "https://example.com"]],
    ["nice -n 5 time make", ["nice", "time"], ["make"]],
    ["command rm x", ["command"], ["rm", "x"]],
  ])("%s", (command, wrappers, argv) => {
    const cmd = parse(command).commands[0]!;
    expect(cmd.wrappers).toEqual(wrappers);
    expect(cmd.argv).toEqual(argv);
  });

  it("detects sudo and sudo -S", () => {
    expect(parse("sudo ls").commands[0]!.sudo).toBe(true);
    expect(parse("echo pw | sudo -S rm x").commands[1]!.sudoStdin).toBe(true);
  });

  it("keeps a bare wrapper as the command", () => {
    expect(parse("env").commands[0]!.name).toBe("env");
    expect(parse("sudo -s").commands[0]!.name).toBe("sudo");
    expect(parse("command -v rm").commands[0]!.argv).toEqual(["command", "-v", "rm"]);
  });

  it("strips leading variable assignments", () => {
    const cmd = parse("NODE_ENV=production API_KEY=x node app.js").commands[0]!;
    expect(cmd.assignments).toEqual(["NODE_ENV=production", "API_KEY=x"]);
    expect(cmd.argv).toEqual(["node", "app.js"]);
  });
});

describe("parseShell: working directory", () => {
  it("tracks cd through lists and restores it after subshells", () => {
    const { commands } = parse("cd ~ && rm -rf a; (cd /tmp && rm b); rm c");
    const cwd = (arg: string) => {
      const c = commands.find((cmd) => cmd.argv.includes(arg))!.cwd;
      return c.kind === "known" ? c.path : "?";
    };
    expect(cwd("a")).toBe("/Users/me");
    expect(cwd("b")).toBe("/tmp");
    expect(cwd("c")).toBe("/Users/me");
  });

  it("forgets the directory after cd - or a computed cd", () => {
    expect(parse("cd - && rm x").commands[1]!.cwd.kind).toBe("unknown");
    expect(parse('cd "$DIR" && rm x').commands[1]!.cwd.kind).toBe("unknown");
    expect(parseShell("rm x").commands[0]!.cwd.kind).toBe("unknown");
  });
});

describe("parseShell: errors and limits", () => {
  it("reports unterminated quotes but keeps what it parsed", () => {
    const analysis = parse("rm -rf / 'oops");
    expect(analysis.error).toMatch(/unterminated/);
    expect(analysis.commands[0]?.argv.slice(0, 3)).toEqual(["rm", "-rf", "/"]);
  });

  it("refuses commands that are too large to analyze", () => {
    const analysis = parse(`echo ${"a".repeat(MAX_SHELL_COMMAND_CHARS)}`);
    expect(analysis.error).toMatch(/too large/);
    expect(analysis.commands).toEqual([]);
  });

  it("limits nesting depth", () => {
    const nested =
      "bash -c ".repeat(1) +
      JSON.stringify(`bash -c ${JSON.stringify("bash -c 'bash -c \"bash -c ls\"'")}`);
    expect(parse(nested).commands.length).toBeGreaterThan(0);
    let deep = "ls";
    for (let i = 0; i < 10; i++) deep = `echo $(${deep})`;
    expect(parse(deep).error).toMatch(/too deep/);
  });
});

describe("shell payload helpers", () => {
  it("finds -c payloads and script operands", () => {
    expect(shellPayload(["bash", "-c", "ls"])).toBe("ls");
    expect(shellPayload(["bash", "-eu", "-c", "ls"])).toBe("ls");
    expect(shellPayload(["bash", "--norc", "script.sh"])).toBeUndefined();
    expect(shellScriptOperand(["bash", "-x", "script.sh"])).toBe("script.sh");
    expect(shellScriptOperand(["bash", "-s"])).toBeUndefined();
  });
});
