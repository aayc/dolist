import { memo } from "react";
import { renderMarkdown } from "../../lib/markdown";

/** Sanitized markdown (marked + DOMPurify; links open in a new tab with rel=noopener). */
export const Markdown = memo(function Markdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  return (
    <div
      className={className ? `markdown ${className}` : "markdown"}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: output is sanitized by DOMPurify
      dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }}
    />
  );
});
