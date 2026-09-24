import {
  addDays,
  ancestorFolders,
  basename,
  type DailyNoteResponse,
  dirname,
  ensureMarkdownExtension,
  isHiddenPath,
  type LocalDate,
  normalizePath,
  resolveWikiLink,
  type ServerEventOf,
  stem,
  today,
  toISODate,
  type VaultTreeResponse,
} from "@ddl/core";
import type { DaemonClient } from "../api/client";
import { ConflictError, errorMessage } from "../api/errors";
import { adjacentDailyTarget, dailyPathFor } from "../features/daily/daily-nav";
import { AnnotationSync } from "../features/editor/annotation-sync";
import { EditorController } from "../features/editor/editor-controller";
import { PresenceReporter } from "../features/editor/presence";
import { WordCounter } from "../features/editor/word-counter";
import { editorConfigFrom } from "../features/settings/theme";
import { afterNextPaint } from "../lib/idle";
import {
  type PerfMetric,
  perfAnnotate,
  perfCancel,
  perfEndAfterPaint,
  perfStart,
  recordMeasure,
} from "../perf/perf";
import { NotesController } from "../state/notes-controller";
import { setSaveState, setWordCount } from "../state/notes-store";
import { getSettings } from "../state/settings-store";
import { placeInTabs, removeFromTabs, renameInTabs, useTabsStore } from "../state/tabs-store";
import { toast } from "../state/toast-store";
import { ui } from "../state/ui-store";
import { vaultActions } from "../state/vault-store";
import type { AgentActions } from "./agent-actions";

export interface OpenOptions {
  newTab?: boolean;
  /** 0-based line to scroll to. */
  line?: number;
  focus?: boolean;
  metric?: PerfMetric;
}

const MAX_CACHED_NOTES = 24;
const INVALID_NAME_RE = /[\\/:*?"<>|#^[\]]/;

export function validateNoteName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name can't be empty";
  if (trimmed.startsWith(".")) return "Name can't start with a dot";
  if (INVALID_NAME_RE.test(trimmed)) return "Name can't contain any of \\ / : * ? \" < > | # ^ [ ]";
  return null;
}

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * The note-side application controller: tabs, navigation (incl. daily notes), CRUD, external
 * changes and flush-on-leave. It drives the editor imperatively; React only renders state.
 */
export class Workspace {
  readonly client: DaemonClient;
  readonly notes: NotesController;
  readonly editor: EditorController;
  readonly annotations: AnnotationSync;
  private readonly agent: AgentActions;
  private readonly presence: PresenceReporter;
  private readonly words: WordCounter;
  private readonly recent: string[] = [];
  private readonly errorToasted = new Set<string>();
  private navToken = 0;
  /** Where the latest navigation is going while its note loads. */
  private navTarget: string | null = null;
  private treeRefresh: ReturnType<typeof setTimeout> | undefined;
  private mountWaiters: Array<() => void> = [];

  constructor(client: DaemonClient, agent: AgentActions) {
    this.client = client;
    this.agent = agent;
    this.notes = new NotesController({
      client,
      hooks: {
        readLive: (path) => this.editor.readLive(path),
        applyRemote: (path, content) => this.editor.applyRemote(path, content),
        onSaveState: (path, state) => {
          setSaveState(path, state);
          if (state === "saved") this.errorToasted.delete(path);
        },
        onConflictCopy: (path, copyPath) => this.onConflictCopy(path, copyPath),
        onRemoteDelete: (path, restored) => this.onRemoteDelete(path, restored),
        onSaveError: (path, error) => this.onSaveError(path, error),
        pathExists: (path) => vaultActions.has(path),
      },
    });
    this.editor = new EditorController(
      {
        contentOf: (path) => this.notes.serverContent(path),
        onLocalEdit: (path) => {
          this.notes.markDirty(path);
          this.annotations.onDocumentEdited();
          this.presence.onEdit(path);
          this.words.schedule();
        },
        onDocumentReplaced: () => {
          this.annotations.recompute();
          this.words.schedule(0);
        },
        onCursorLine: (path, line) => this.presence.onCursorLine(path, line),
        onAnnotationClick: (annotation) =>
          this.agent.openTaskThread(annotation.id, annotation.threadId),
        onWikiLinkClick: (target, newPane) => void this.openWikiLink(target, newPane),
        onExternalLinkClick: openExternal,
        onSaveRequested: (path) => void this.notes.flush(path),
        beforeDeactivate: (path) => void this.notes.flush(path),
        canEvict: (path) =>
          !useTabsStore.getState().tabs.includes(path) && !this.notes.isBusy(path),
      },
      editorConfigFrom(getSettings()),
    );
    this.annotations = new AnnotationSync(this.editor);
    this.presence = new PresenceReporter((notePath, line) =>
      client.send({ type: "editor.activity", notePath, line }),
    );
    this.words = new WordCounter(() => this.editor.getDocument(), setWordCount);
  }

  get activePath(): string | null {
    return useTabsStore.getState().active;
  }

  mountEditor(parent: HTMLElement): void {
    this.editor.mount(parent);
    const waiters = this.mountWaiters;
    this.mountWaiters = [];
    for (const resolve of waiters) resolve();
  }

  unmountEditor(): void {
    this.editor.unmount();
  }

  whenEditorMounted(): Promise<void> {
    if (this.editor.mounted) return Promise.resolve();
    return new Promise((resolve) => this.mountWaiters.push(resolve));
  }

  // ── Opening notes ──────────────────────────────────────────────────────

  /** Starts a navigation, superseding any that is still loading. `target`: where it is going. */
  private beginNavigation(target: string | null): number {
    this.navTarget = target;
    return ++this.navToken;
  }

  private endNavigation(token: number): void {
    if (token === this.navToken) this.navTarget = null;
  }

  async openNote(path: string, options: OpenOptions = {}): Promise<boolean> {
    const token = this.beginNavigation(path);
    if (!this.notes.has(path)) {
      try {
        await this.notes.load(path);
      } catch (error) {
        if (options.metric) perfCancel(options.metric);
        if (token === this.navToken) {
          toast({
            kind: "error",
            title: `Couldn't open “${stem(path)}”`,
            body: errorMessage(error),
          });
        }
        this.endNavigation(token);
        return false;
      }
      if (token !== this.navToken) {
        if (options.metric) perfCancel(options.metric);
        return false;
      }
    }
    this.endNavigation(token);
    this.activate(path, options);
    return true;
  }

  /** Synchronous switch to an already-loaded note. */
  activate(path: string, options: OpenOptions = {}): void {
    const state = useTabsStore.getState();
    const next = placeInTabs(state, path, options.newTab ?? false);
    this.editor.show(path);
    if (next.tabs !== state.tabs || next.active !== state.active) useTabsStore.setState(next);
    this.afterActivate(path, options);
  }

  activateTab(path: string, start?: number): void {
    // The click wins over a note still loading from an earlier navigation.
    this.beginNavigation(null);
    if (useTabsStore.getState().active === path) return;
    perfStart("tab:switch", start);
    this.activate(path, { metric: "tab:switch" });
  }

  closeTab(path: string): void {
    const state = useTabsStore.getState();
    const next = removeFromTabs(state, path);
    if (next === state) return;
    void this.notes.flush(path);
    const wasActive = state.active === path;
    if (wasActive) this.editor.show(next.active);
    useTabsStore.setState(next);
    if (!wasActive) return;
    if (next.active) this.afterActivate(next.active, {});
    else this.onNoActiveNote();
  }

  closeActiveTab(): void {
    const active = this.activePath;
    if (active) this.closeTab(active);
  }

  private afterActivate(path: string, options: OpenOptions): void {
    if (options.line !== undefined) this.editor.scrollToLine(options.line);
    if (options.focus !== false) this.editor.focus();
    this.annotations.setActive(path);
    this.words.schedule(0);
    this.agent.refreshRecords(path);
    const ancestors = ancestorFolders(path);
    if (ancestors.length > 0) ui.expandAll(ancestors);
    this.touch(path);
    if (options.metric) perfEndAfterPaint(options.metric);
  }

  private onNoActiveNote(): void {
    this.annotations.setActive(null);
    this.presence.reset();
    setWordCount(null);
  }

  /** Keeps a bounded set of recently used notes loaded (instant back-navigation). */
  private touch(path: string): void {
    const index = this.recent.indexOf(path);
    if (index !== -1) this.recent.splice(index, 1);
    this.recent.unshift(path);
    const tabs = useTabsStore.getState().tabs;
    for (let i = this.recent.length - 1; i >= MAX_CACHED_NOTES; i--) {
      const candidate = this.recent[i]!;
      if (
        tabs.includes(candidate) ||
        this.notes.isBusy(candidate) ||
        candidate === this.activePath
      ) {
        continue;
      }
      this.recent.splice(i, 1);
      this.notes.forget(candidate);
      this.editor.forget(candidate);
    }
  }

  /** Drops a note from the caches (test hook for measuring uncached opens). */
  evict(path: string): void {
    if (useTabsStore.getState().tabs.includes(path) || this.notes.isBusy(path)) return;
    const index = this.recent.indexOf(path);
    if (index !== -1) this.recent.splice(index, 1);
    this.notes.forget(path);
    this.editor.forget(path);
  }

  async openWikiLink(target: string, newTab: boolean): Promise<void> {
    const resolved = resolveWikiLink(target, vaultActions.files());
    if (resolved) {
      await this.openNote(resolved, { newTab });
      return;
    }
    let path: string;
    try {
      path = ensureMarkdownExtension(normalizePath(target));
    } catch {
      toast({ kind: "error", title: "Invalid link target", body: target });
      return;
    }
    await this.createNoteAt(path, { newTab, focusTitle: false });
  }

  // ── Daily notes ────────────────────────────────────────────────────────

  openToday(start?: number): Promise<void> {
    return this.openDaily(today(), "daily:open", start);
  }

  openTomorrow(): Promise<void> {
    return this.openDaily(addDays(today(), 1), "daily:open");
  }

  /** Opens (creating from the template if needed — server side) the daily note for `date`. */
  async openDaily(
    date: LocalDate,
    metric: PerfMetric = "daily:open",
    start?: number,
  ): Promise<void> {
    perfStart(metric, start);
    const path = dailyPathFor(date, getSettings().dailyNotes);
    if (path && this.notes.has(path)) {
      this.beginNavigation(null);
      perfAnnotate(metric, { cached: true });
      this.activate(path, { metric });
      return;
    }
    perfAnnotate(metric, { cached: false });
    const token = this.beginNavigation(path);
    try {
      const note = await this.client.getDailyNote(toISODate(date), true);
      if (token !== this.navToken) {
        perfCancel(metric);
        return;
      }
      this.endNavigation(token);
      this.adoptDaily(note);
      this.activate(note.path, { metric });
    } catch (error) {
      this.endNavigation(token);
      perfCancel(metric);
      toast({ kind: "error", title: "Couldn't open the daily note", body: errorMessage(error) });
    }
  }

  adoptDaily(note: DailyNoteResponse): void {
    this.notes.adopt(note);
    if (!vaultActions.has(note.path)) vaultActions.addFile(note.path, note.version);
  }

  /** Startup: show today's note and record `app:interactive` once it is on screen. */
  async showStartupNote(note: DailyNoteResponse): Promise<void> {
    this.adoptDaily(note);
    await this.whenEditorMounted();
    if (this.activePath === null) this.activate(note.path, {});
    afterNextPaint(() => recordMeasure("app:interactive", 0, performance.now()));
  }

  openAdjacentDaily(direction: -1 | 1, start?: number): Promise<boolean> {
    const settings = getSettings().dailyNotes;
    // Repeated keys continue from the note still loading, instead of re-picking the same one.
    const from = this.navTarget ?? this.activePath;
    const target = adjacentDailyTarget(vaultActions.files(), from, direction, settings);
    if (!target) {
      toast({
        kind: "info",
        title: direction === -1 ? "No previous daily note" : "No next daily note",
        timeoutMs: 2500,
      });
      return Promise.resolve(false);
    }
    const metric: PerfMetric = direction === -1 ? "daily:prev" : "daily:next";
    perfStart(metric, start, { cached: this.notes.has(target.path) });
    return this.openNote(target.path, { metric });
  }

  // ── Create / rename / delete ───────────────────────────────────────────

  private uniquePath(folder: string, base: string, extension = ".md"): string {
    const prefix = folder ? `${folder}/` : "";
    for (let n = 0; ; n++) {
      const candidate = `${prefix}${n === 0 ? base : `${base} ${n}`}${extension}`;
      if (!vaultActions.has(candidate)) return candidate;
    }
  }

  async createNote(options: { folder?: string; name?: string; newTab?: boolean } = {}) {
    const name = options.name?.trim();
    if (name) {
      let path: string;
      try {
        path = ensureMarkdownExtension(
          normalizePath(options.folder ? `${options.folder}/${name}` : name),
        );
      } catch {
        toast({ kind: "error", title: "Invalid note name", body: name });
        return null;
      }
      const invalid = validateNoteName(stem(path));
      if (invalid) {
        toast({ kind: "error", title: "Invalid note name", body: invalid });
        return null;
      }
      return this.createNoteAt(path, { newTab: options.newTab ?? true, focusTitle: false });
    }
    const path = this.uniquePath(options.folder ?? "", "Untitled");
    return this.createNoteAt(path, { newTab: options.newTab ?? true, focusTitle: true });
  }

  private async createNoteAt(
    path: string,
    options: { newTab: boolean; focusTitle: boolean },
  ): Promise<string | null> {
    if (vaultActions.has(path)) {
      await this.openNote(path, { newTab: options.newTab });
      return path;
    }
    try {
      const response = await this.client.writeNote(path, { content: "", baseVersion: null });
      vaultActions.addFile(response.path, response.version);
      this.notes.adopt({
        path: response.path,
        content: "",
        version: response.version,
        mtime: response.mtime,
      });
      this.activate(response.path, { newTab: options.newTab, focus: !options.focusTitle });
      if (options.focusTitle) ui.set({ titleFocus: response.path });
      return response.path;
    } catch (error) {
      if (error instanceof ConflictError && error.current) {
        this.notes.adopt(error.current);
        vaultActions.addFile(path);
        this.activate(path, { newTab: options.newTab });
        return path;
      }
      toast({ kind: "error", title: "Couldn't create the note", body: errorMessage(error) });
      return null;
    }
  }

  async createFolder(parent = ""): Promise<string | null> {
    const path = this.uniquePath(parent, "Untitled folder", "");
    try {
      await this.client.createFolder(path);
    } catch (error) {
      toast({ kind: "error", title: "Couldn't create the folder", body: errorMessage(error) });
      return null;
    }
    vaultActions.addFolder(path);
    if (parent) ui.setExpanded(parent, true);
    ui.set({ renaming: path });
    return path;
  }

  /** Renames the note's file stem (title rename). */
  renameNoteTitle(path: string, title: string): Promise<boolean> {
    const invalid = validateNoteName(title);
    if (invalid) {
      toast({ kind: "error", title: "Can't rename", body: invalid });
      return Promise.resolve(false);
    }
    const folder = dirname(path);
    const target = `${folder ? `${folder}/` : ""}${title.trim()}.md`;
    return this.renamePath(path, target);
  }

  /** Renames a file or folder in place (explorer inline rename). */
  renameEntry(path: string, name: string): Promise<boolean> {
    const invalid = validateNoteName(name);
    if (invalid) {
      toast({ kind: "error", title: "Can't rename", body: invalid });
      return Promise.resolve(false);
    }
    const folder = dirname(path);
    const isFolder = vaultActions.isFolder(path);
    const leaf = isFolder ? name.trim() : ensureMarkdownExtension(name.trim());
    return this.renamePath(path, `${folder ? `${folder}/` : ""}${leaf}`);
  }

  async renamePath(from: string, to: string): Promise<boolean> {
    if (from === to) return true;
    if (vaultActions.has(to)) {
      toast({ kind: "error", title: "Can't rename", body: `“${basename(to)}” already exists` });
      return false;
    }
    const affected = this.notes.paths().filter((p) => p === from || p.startsWith(`${from}/`));
    await Promise.all(affected.map((p) => this.notes.flush(p)));
    try {
      await this.client.renamePath(from, to);
    } catch (error) {
      toast({ kind: "error", title: "Couldn't rename", body: errorMessage(error) });
      return false;
    }
    vaultActions.rename(from, to);
    this.notes.rename(from, to);
    this.editor.rename(from, to);
    useTabsStore.setState(renameInTabs(useTabsStore.getState(), from, to));
    for (let i = 0; i < this.recent.length; i++) {
      const p = this.recent[i]!;
      if (p === from) this.recent[i] = to;
      else if (p.startsWith(`${from}/`)) this.recent[i] = `${to}${p.slice(from.length)}`;
    }
    for (const p of affected) {
      this.agent.forgetRecords(p);
    }
    const active = this.activePath;
    if (active) {
      this.agent.refreshRecords(active, true);
      this.annotations.setActive(active);
    }
    return true;
  }

  requestDelete(path: string): void {
    const isFolder = vaultActions.isFolder(path);
    const name = isFolder ? basename(path) : stem(path);
    ui.confirm({
      title: `Delete “${name}”?`,
      message: isFolder
        ? "The folder and everything in it will be deleted. This can't be undone."
        : "The note will be deleted. This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => void this.deletePath(path),
    });
  }

  async deletePath(path: string): Promise<boolean> {
    const isFolder = vaultActions.isFolder(path);
    try {
      if (isFolder) await this.client.deleteFolder(path);
      else await this.client.deleteNote(path);
    } catch (error) {
      toast({ kind: "error", title: "Couldn't delete", body: errorMessage(error) });
      return false;
    }
    const affected = isFolder
      ? vaultActions.files().filter((p) => p.startsWith(`${path}/`))
      : [path];
    for (const p of affected) this.dropNote(p);
    vaultActions.remove(path);
    return true;
  }

  /** Removes a note that no longer exists from every cache and tab (without saving it). */
  private dropNote(path: string): void {
    this.notes.forget(path);
    this.editor.forget(path);
    this.agent.forgetRecords(path);
    const index = this.recent.indexOf(path);
    if (index !== -1) this.recent.splice(index, 1);
    this.closeTab(path);
  }

  // ── Remote changes ─────────────────────────────────────────────────────

  handleVaultChanged(event: ServerEventOf<"vault.changed">): void {
    if (event.clientId !== undefined && event.clientId === this.client.clientId) return;
    for (const change of event.changes) {
      if (isHiddenPath(change.path)) continue;
      if (change.kind === "deleted") {
        const nested = this.notes.paths().filter((p) => p.startsWith(`${change.path}/`));
        for (const p of [change.path, ...nested]) this.notes.handleRemoteDelete(p);
        vaultActions.remove(change.path);
        continue;
      }
      if (!vaultActions.has(change.path)) {
        if (/\.[^/]+$/.test(change.path)) vaultActions.addFile(change.path, change.version);
        else this.scheduleTreeRefresh();
      }
      if (this.notes.has(change.path))
        void this.notes.handleRemoteChange(change.path, change.version);
    }
  }

  private scheduleTreeRefresh(): void {
    clearTimeout(this.treeRefresh);
    this.treeRefresh = setTimeout(() => void this.refreshTree(), 300);
  }

  async refreshTree(): Promise<void> {
    try {
      this.applyTree(await this.client.getTree());
    } catch {
      // Keep the current tree; the next resync retries.
    }
  }

  /** Replaces the tree, keeping notes we know exist (the snapshot may predate a creation). */
  applyTree(tree: VaultTreeResponse): void {
    vaultActions.setTree(tree);
    for (const path of this.notes.paths())
      vaultActions.addFile(path, this.notes.version(path) ?? undefined);
  }

  /** After a reconnect: events may have been missed, so re-validate everything we show. */
  async resync(): Promise<void> {
    await this.refreshTree();
    for (const path of this.notes.paths()) void this.notes.handleRemoteChange(path);
  }

  private onConflictCopy(path: string, copyPath: string): void {
    vaultActions.addFile(copyPath);
    toast({
      kind: "warning",
      title: `“${stem(path)}” changed elsewhere`,
      body: `Kept your version. The other version was saved as “${stem(copyPath)}”.`,
      actionLabel: "Open",
      onClick: () => void this.openNote(copyPath, { newTab: true }),
      timeoutMs: 10_000,
    });
  }

  private onRemoteDelete(path: string, restored: boolean): void {
    if (restored) {
      vaultActions.addFile(path);
      toast({
        kind: "warning",
        title: `“${stem(path)}” was deleted elsewhere`,
        body: "Your unsaved edits were written back, so the note was restored.",
      });
      return;
    }
    const wasOpen = useTabsStore.getState().tabs.includes(path);
    this.dropNote(path);
    if (wasOpen) toast({ kind: "info", title: `“${stem(path)}” was deleted`, timeoutMs: 3000 });
  }

  private onSaveError(path: string, error: unknown): void {
    if (this.errorToasted.has(path)) return;
    this.errorToasted.add(path);
    toast({
      kind: "error",
      title: `Couldn't save “${stem(path)}”`,
      body: `${errorMessage(error)} — retrying automatically.`,
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Flushes pending edits when the window loses focus, is hidden or unloads. */
  installLifecycle(): () => void {
    const flush = () => void this.notes.flushAll();
    const flushKeepalive = () => void this.notes.flushAll({ keepalive: true });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushKeepalive();
    };
    window.addEventListener("blur", flush);
    window.addEventListener("pagehide", flushKeepalive);
    window.addEventListener("beforeunload", flushKeepalive);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("pagehide", flushKeepalive);
      window.removeEventListener("beforeunload", flushKeepalive);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }
}
