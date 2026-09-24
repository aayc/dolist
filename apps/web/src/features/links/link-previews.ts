import { type CitedSource, resolveWikiLink, stem, stripAgentMarker } from "@ddl/core";
import { type LinkPreview, type LinkPreviewRequest, webLinkPreview } from "@ddl/editor";
import { LruMap } from "../../lib/lru";

const NOTE_PREVIEW_LINES = 8;
const CACHED_NOTES = 50;
const FRONTMATTER_OPEN = /^---\s*$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)\s*$/;

/** A note's first `max` non-empty lines, without frontmatter or agent markers. */
export function notePreviewLines(content: string, max = NOTE_PREVIEW_LINES): string[] {
  const lines = content.split(/\r?\n/);
  let start = 0;
  if (lines.length > 1 && FRONTMATTER_OPEN.test(lines[0]!)) {
    const close = lines.findIndex((line, i) => i > 0 && FRONTMATTER_CLOSE.test(line));
    if (close !== -1) start = close + 1;
  }
  const out: string[] = [];
  for (let i = start; i < lines.length && out.length < max; i++) {
    const line = stripAgentMarker(lines[i]!).replace(/\t/g, "  ").trimEnd();
    if (line.trim() !== "") out.push(line);
  }
  return out;
}

function sourceKey(url: string): string | null {
  try {
    const { hostname, pathname, search } = new URL(url);
    return `${hostname.replace(/^www\./i, "").toLowerCase()}${pathname.replace(/\/+$/, "")}${search}`;
  } catch {
    return null;
  }
}

/** The cited source for `url`: the same address, else the same page (ignoring www, `#`, a trailing /). */
export function findSource(sources: readonly CitedSource[], url: string): CitedSource | undefined {
  const exact = sources.find((source) => source.url === url);
  if (exact) return exact;
  const key = sourceKey(url);
  return key === null ? undefined : sources.find((source) => sourceKey(source.url) === key);
}

const MARKDOWN_WEB_LINK = /\]\((https?:\/\/[^\s)]+)/g;

/** Web links in agent text that aren't among the thread's known sources. */
export function uncitedLinks(text: string, sources: readonly CitedSource[] = []): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(MARKDOWN_WEB_LINK)) {
    const url = match[1]!;
    if (!findSource(sources, url) && !out.includes(url)) out.push(url);
  }
  return out;
}

export interface LinkPreviewDeps {
  files(): readonly string[];
  /** The text of a note that is open (as shown in the editor), else null. */
  openContent(path: string): string | null;
  readNote(path: string): Promise<string>;
  /** The web pages a thread cites (empty when it can't be loaded). */
  sources(threadId: string): Promise<readonly CitedSource[]>;
}

/**
 * Hover previews for links in notes and threads. Web links are described by the sources their
 * thread cites (never by fetching the page); note links by the start of the note, read through
 * the daemon and cached until the note changes.
 */
export class LinkPreviews {
  private readonly deps: LinkPreviewDeps;
  private readonly notes = new LruMap<string, Promise<string | null>>(CACHED_NOTES);

  constructor(deps: LinkPreviewDeps) {
    this.deps = deps;
  }

  forEditor({ link, label, threadId }: LinkPreviewRequest): Promise<LinkPreview> {
    return link.kind === "wiki" ? this.note(link.target) : this.web(link.url, label, threadId);
  }

  async web(url: string, label: string, threadId: string | null): Promise<LinkPreview> {
    const sources = threadId ? await this.deps.sources(threadId) : [];
    return webLinkPreview(url, label, findSource(sources, url));
  }

  async note(target: string): Promise<LinkPreview> {
    const path = resolveWikiLink(target, this.deps.files());
    if (!path) return { kind: "note", title: target, lines: [], missing: true };
    const content = this.deps.openContent(path) ?? (await this.read(path));
    if (content === null) return { kind: "note", title: stem(path), lines: [], missing: true };
    return { kind: "note", title: stem(path), lines: notePreviewLines(content) };
  }

  /** The note changed or went away: its next preview reads it again. */
  invalidate(path: string): void {
    this.notes.delete(path);
  }

  private read(path: string): Promise<string | null> {
    let pending = this.notes.get(path);
    if (!pending) {
      pending = this.deps.readNote(path).catch(() => {
        this.notes.delete(path);
        return null;
      });
      this.notes.set(path, pending);
    }
    return pending;
  }
}
