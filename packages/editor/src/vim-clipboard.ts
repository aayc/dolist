/**
 * The system clipboard as vim's `+` and `*` registers. vim.js reads registers synchronously, so
 * reads come from a cache kept fresh from the clipboard API when the page may read it (focus,
 * `"+`/`"*`/`<C-r>`, clipboard events); writes go straight through. Without clipboard permission
 * the registers still work inside the app, holding what vim last yanked into them.
 */

export interface ClipboardAccess {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

export interface RegisterContent {
  text: string;
  linewise: boolean;
  blockwise: boolean;
}

export class SystemClipboard {
  private cached = "";
  private written: RegisterContent | null = null;
  private readonly access: () => ClipboardAccess | undefined;
  private readonly mayRead: () => Promise<boolean>;

  constructor(access: () => ClipboardAccess | undefined, mayRead: () => Promise<boolean>) {
    this.access = access;
    this.mayRead = mayRead;
  }

  /** What the registers hold: what vim wrote (keeping its shape) or text copied elsewhere. */
  get content(): RegisterContent {
    if (this.written && this.written.text === this.cached) return this.written;
    // Like Vim, text that ends with a line break pastes linewise.
    return { text: this.cached, linewise: this.cached.endsWith("\n"), blockwise: false };
  }

  write(content: RegisterContent): void {
    this.cached = content.text;
    this.written = content;
    this.access()
      ?.writeText(content.text)
      .catch(() => {});
  }

  /** Text copied or pasted in the page (clipboard events carry it without a permission prompt). */
  observe(text: string): void {
    this.cached = text;
  }

  /**
   * Re-reads the clipboard. `explicit` reads (the user asked for a clipboard register) may show
   * the browser's permission prompt; background refreshes only read when access was granted.
   */
  async refresh(explicit: boolean): Promise<void> {
    const access = this.access();
    if (!access) return;
    if (!explicit && !(await this.mayRead())) return;
    try {
      this.cached = await access.readText();
    } catch {
      // Denied or unavailable: keep the last known content.
    }
  }
}

/** A vim.js register backed by the system clipboard (the engine's `Register` interface). */
export class ClipboardRegister {
  insertModeChanges: unknown[] = [];
  searchQueries: string[] = [];
  private readonly clipboard: SystemClipboard;

  constructor(clipboard: SystemClipboard) {
    this.clipboard = clipboard;
  }

  get keyBuffer(): string[] {
    return [this.clipboard.content.text];
  }

  get linewise(): boolean {
    return this.clipboard.content.linewise;
  }

  get blockwise(): boolean {
    return this.clipboard.content.blockwise;
  }

  setText(text?: string, linewise?: boolean, blockwise?: boolean): void {
    this.clipboard.write({
      text: text ?? "",
      linewise: Boolean(linewise),
      blockwise: Boolean(blockwise),
    });
  }

  /** Uppercase-register append (vim.js semantics: a linewise append adds a line break first). */
  pushText(text: string, linewise?: boolean): void {
    const current = this.clipboard.content;
    const separator = linewise && !current.linewise && current.text !== "" ? "\n" : "";
    this.clipboard.write({
      text: current.text + separator + text,
      linewise: current.linewise || Boolean(linewise),
      blockwise: false,
    });
  }

  pushInsertModeChanges(changes: unknown): void {
    this.insertModeChanges.push(changes);
  }

  pushSearchQuery(query: string): void {
    this.searchQueries.push(query);
  }

  clear(): void {
    this.insertModeChanges = [];
    this.searchQueries = [];
    this.clipboard.write({ text: "", linewise: false, blockwise: false });
  }

  toString(): string {
    return this.clipboard.content.text;
  }
}

/** Whether a `clipboard` option value mirrors the unnamed register (`unnamed`, `unnamedplus`). */
export function mirrorsUnnamed(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.split(",").some((v) => v === "unnamed" || v === "unnamedplus")
  );
}
