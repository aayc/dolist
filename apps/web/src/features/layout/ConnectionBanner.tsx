import { WifiOff } from "lucide-react";
import { useConnectionStore } from "../../state/connection-store";

export function ConnectionBanner() {
  const unreachable = useConnectionStore((s) => s.unreachable && s.state !== "online");
  const endpoint = useConnectionStore((s) => s.endpoint);
  if (!unreachable) return null;
  return (
    <div className="connection-banner" role="status" data-testid="connection-banner">
      <WifiOff size={14} aria-hidden="true" />
      <span>
        Can't reach the Daily Do List daemon at <code>{endpoint}</code>. Retrying… Start it with{" "}
        <code>pnpm dev</code>, or open <a href="?mock=1">the in-browser demo</a>.
      </span>
    </div>
  );
}
