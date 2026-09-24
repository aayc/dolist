import type { SurfaceKind } from "@ddl/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useServices } from "../../app/services";

function subscribeVisibility(callback: () => void): () => void {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
    () => true,
  );
}

/** Frames only flow while a view is on screen: subscribe on mount/visible, unsubscribe otherwise. */
export function useSurfaceSubscription(threadId: string, surface: SurfaceKind): void {
  const { client } = useServices();
  const visible = usePageVisible();
  useEffect(() => {
    if (!visible) return;
    client.send({ type: "surface.subscribe", threadId, surface });
    return () => client.send({ type: "surface.unsubscribe", threadId, surface });
  }, [client, threadId, surface, visible]);
}

/** True while frames keep arriving (last one newer than `windowMs`). */
export function useIsLive(lastFrameTs: number | undefined, windowMs = 2500): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (lastFrameTs === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [lastFrameTs]);
  return lastFrameTs !== undefined && now - lastFrameTs < windowMs;
}
