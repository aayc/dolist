import { errorMessage, type SearchHit, stem } from "@ddl/core";
import { LoaderCircle, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServices } from "../../app/services";
import { pluralize } from "../../lib/format";
import { useUiStore } from "../../state/ui-store";
import "../../styles/search.css";

interface Group {
  path: string;
  hits: SearchHit[];
}

function highlight(preview: string, query: string) {
  const at = preview.toLowerCase().indexOf(query.toLowerCase());
  if (!query || at === -1) return preview;
  return (
    <>
      {preview.slice(0, at)}
      <mark>{preview.slice(at, at + query.length)}</mark>
      {preview.slice(at + query.length)}
    </>
  );
}

export function SearchView() {
  const { client, workspace } = useServices();
  const focusToken = useUiStore((s) => s.searchFocus);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-focus whenever Mod+Shift+F is pressed again (the token changes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the token is the trigger
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      client.search(q).then(
        (response) => {
          if (cancelled) return;
          setHits(response.hits);
          setError(null);
          setLoading(false);
        },
        (err: unknown) => {
          if (cancelled) return;
          setError(errorMessage(err));
          setLoading(false);
        },
      );
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, client]);

  const groups = useMemo(() => {
    const map = new Map<string, Group>();
    for (const hit of hits) {
      const group = map.get(hit.path) ?? { path: hit.path, hits: [] };
      group.hits.push(hit);
      map.set(hit.path, group);
    }
    return [...map.values()];
  }, [hits]);

  const q = query.trim();
  return (
    <div className="search-view" data-testid="search-view">
      <div className="panel-header" data-tooltip-placement="bottom">
        <span className="panel-title">Search</span>
      </div>
      <label className="search-input-wrap">
        <Search size={14} aria-hidden="true" />
        <input
          ref={inputRef}
          className="search-input"
          placeholder="Search the vault…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          spellCheck={false}
          aria-label="Search the vault"
          data-testid="search-input"
        />
        {loading ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null}
      </label>
      {/* It describes the results shown, which stay while the next ones load. */}
      {q && !error && (!loading || hits.length > 0) ? (
        <div className="search-summary">
          {pluralize(hits.length, "result")} in {pluralize(groups.length, "note")}
        </div>
      ) : null}
      {error ? <div className="search-error">{error}</div> : null}
      <div className="search-results">
        {groups.map((group) => (
          <section key={group.path} className="search-group">
            <button
              type="button"
              className="search-group-title"
              onClick={(event) =>
                void workspace.openNote(group.path, { newTab: event.metaKey || event.ctrlKey })
              }
            >
              {stem(group.path)}
              <span className="search-group-path">{group.path}</span>
            </button>
            {group.hits.map((hit) => (
              <button
                type="button"
                key={`${hit.path}:${hit.line}`}
                className="search-hit"
                data-testid="search-hit"
                onClick={(event) =>
                  void workspace.openNote(hit.path, {
                    line: hit.line,
                    newTab: event.metaKey || event.ctrlKey,
                  })
                }
              >
                <span className="search-hit-line">{hit.kind === "name" ? "·" : hit.line + 1}</span>
                <span className="search-hit-preview">{highlight(hit.preview, q)}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
