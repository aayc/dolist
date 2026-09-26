// `s`: `.` must also match U+2028/U+2029, which a value may contain (lines split on \r and \n only).
const ASSIGNMENT_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/s;
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t" };

/**
 * Minimal `.env` parser: `KEY=value`, optional `export`, `#` comments, single quotes (literal) and
 * double quotes (`\n`, `\r`, `\t`, `\"`, `\\`). No interpolation and no multi-line values.
 */
export function parseEnvFile(source: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rawLine of source.split(/\r\n?|\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = ASSIGNMENT_RE.exec(line);
    if (!match) continue;
    const value = parseValue(match[2]!.trim());
    if (value !== null) vars.set(match[1]!, value);
  }
  return vars;
}

function parseValue(raw: string): string | null {
  if (raw.startsWith('"')) {
    let out = "";
    for (let i = 1; i < raw.length; i++) {
      const ch = raw[i]!;
      if (ch === '"') return out;
      if (ch === "\\" && i + 1 < raw.length) {
        i++;
        const escaped = raw[i]!;
        out += DOUBLE_QUOTE_ESCAPES[escaped] ?? escaped;
        continue;
      }
      out += ch;
    }
    return null;
  }
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    return end === -1 ? null : raw.slice(1, end);
  }
  const comment = raw.search(/\s#/);
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}
