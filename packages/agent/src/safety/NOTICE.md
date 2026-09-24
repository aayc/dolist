# Third-party notice

Parts of this module are **adapted from Hermes Agent (MIT)** — `tools/approval_detection.py` and
`tools/approval_smart.py` of [Hermes Agent](https://github.com/NousResearch/hermes-agent). The
patterns were re-implemented in TypeScript on top of our own shell parser (`shell.ts`); no code
was copied verbatim. Files containing adapted logic say so in their header.

## Adapted patterns

Hard-deny ("hardline") rules — never allowed, even with approval:

| Hermes pattern | Our rule | Changes |
| --- | --- | --- |
| recursive delete of root filesystem (`/`, `//`, `/.`, `/*`) | `shell.hardline.rm-root` | Structural: runs on parsed `rm` targets after `cd` tracking, brace expansion and quoting are resolved; also covers `find / -delete` without filters |
| recursive delete of system directory (`/home /root /etc /usr /var /bin /sbin /boot /lib`) | `shell.hardline.rm-system-dir` | Adds macOS roots (`/System`, `/Library`, `/Applications`, `/Users`, `/private`, `/Volumes`, …) and globs such as `/u*` |
| recursive delete of home directory (`~`, `$HOME`) | `shell.hardline.rm-home` | Also `/Users/<name>`, `/home/<name>`, `~/..`, and `.`/`*` after `cd ~` |
| format filesystem (`mkfs`) | `shell.hardline.format-disk` | Adds `newfs_*`, `wipefs`, `sgdisk --zap-all`, `diskutil eraseDisk/eraseVolume/zeroDisk/…` |
| dd to raw block device; redirect to raw block device | `shell.hardline.raw-device-write` | Adds macOS `/dev/disk*` and `/dev/rdisk*`; any write role (redirect, `dd of=`, `cp`/`tee` destination) |
| fork bomb | `shell.hardline.fork-bomb` | Matched on quote-masked text, raw text when the command carries a shell payload |
| kill all processes (`kill -1`) | `shell.hardline.kill-all` | Structural: the target argument is `-1` (or PID 1) |
| shutdown / reboot / halt / poweroff, `init 0/6`, `telinit 0/6`, `systemctl poweroff/reboot/halt/kexec` | `shell.hardline.shutdown` | Adds `launchctl reboot` and AppleScript "shut down/restart" |
| sudo stdin guard (`sudo -S`) | `shell.hardline.sudo-stdin` | Unconditional (we never configure a sudo password) |
| parser limit exceeded | `shell.hardline.too-large` | Commands over 64 000 characters are denied |
| The same rm/mkfs/dd/fork-bomb/kill patterns inside code strings | `shell.hardline.embedded` | Applied to inline interpreter code (`python -c`, `node -e`, heredocs) and to text typed into terminals |

Detection techniques:

- Command normalization before matching: NFKC (full-width characters), NUL and zero-width
  character removal, backslash-newline continuations, `$IFS`/`${IFS…}` splicing, backslash and
  empty-quote word splitting (`r\m`, `r''m`), and `$'\x..'` ANSI-C strings.
- Command-position awareness (a pattern inside quoted prose such as `echo "rm -rf /"` or a commit
  message does not fire) and quote masking for position-less patterns.
- Treating `sh -c`/`bash -c`/`eval`/`su -c` payloads and heredocs fed to shells as code.

Approval rules derived from Hermes' `DANGEROUS_PATTERNS` (ours require approval rather than deny):
downloaded script piped to a shell and process substitution of `curl`/`wget` (`system.remote-code`),
decode-and-execute via `base64 -d`/`xxd -r`/`tr` (`system.obfuscated-exec`), `git reset --hard`,
`git clean -f`, `git branch -D` (`destructive.git-discard`), force push (`destructive.git-force-push`),
world-writable `chmod` and recursive `chown` (`system.permissions`), SQL `DROP`/`TRUNCATE`/`DELETE`
without `WHERE` (`destructive.sql`), `crontab -r`, `systemctl stop/disable` (`system.persistence`),
cloud instance-metadata endpoints (`credentials.cloud-metadata`), and writes to shell startup
files, `~/.ssh` and credential files (`system.persistence-write`, `credentials.credential-file-write`).

LLM judge prompt-injection defenses from Hermes' smart approvals (`llm-judge.ts`): unquoted shell
comments are stripped before the command is shown to the judge, untrusted text is fenced in tags,
and the system prompt tells the judge to ignore instructions inside them.

## License of the original work

```
MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
