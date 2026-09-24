import type { ReactNode } from "react";

/** Renders `text` with the characters at `indices` wrapped in <mark>. */
export function Highlight({ text, indices }: { text: string; indices: readonly number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const marked = new Set(indices);
  const out: ReactNode[] = [];
  let run = "";
  let runMarked = false;
  const flush = (key: number) => {
    if (!run) return;
    out.push(runMarked ? <mark key={key}>{run}</mark> : run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const isMarked = marked.has(i);
    if (isMarked !== runMarked) {
      flush(i);
      runMarked = isMarked;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}
