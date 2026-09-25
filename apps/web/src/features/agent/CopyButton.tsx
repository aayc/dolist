import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "../../components/IconButton";
import { copyText } from "../../lib/clipboard";
import { cx } from "../../lib/cx";

const COPIED_MS = 1500;

/** Copies a message's text; says "Copied" for a moment after. */
export function CopyButton({ getText, className }: { getText: () => string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={copied ? "Copied" : "Copy message"}
      size={14}
      className={cx("message-copy", copied && "is-copied", className)}
      onClick={() => {
        void copyText(getText()).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
      data-testid="message-copy"
    />
  );
}
