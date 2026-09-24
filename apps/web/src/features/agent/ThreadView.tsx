import type { SurfaceKind } from "@ddl/core";
import { useEffect, useLayoutEffect } from "react";
import { useShallow } from "zustand/shallow";
import { useServices } from "../../app/services";
import { cx } from "../../lib/cx";
import { perfEndAfterPaint, perfPending } from "../../perf/perf";
import { findRecordIn } from "../../state/agent-reducer";
import { useAgentStore } from "../../state/agent-store";
import { type ThreadTab, ui, useUiStore } from "../../state/ui-store";
import { ArtifactsTab } from "./ArtifactsTab";
import { BrowserView } from "./BrowserView";
import { ChatTab } from "./ChatTab";
import { ComputerView } from "./ComputerView";
import { ThreadHeader } from "./ThreadHeader";

const NO_SURFACES: readonly SurfaceKind[] = [];

export function ThreadView({ threadId }: { threadId: string }) {
  const { agent } = useServices();
  const loaded = useAgentStore((s) => threadId in s.details);
  const surfaces = useAgentStore(
    useShallow(
      (s) => s.details[threadId]?.surfaces ?? s.threads[threadId]?.surfaces ?? NO_SURFACES,
    ),
  );
  const artifactCount = useAgentStore(
    (s) => s.details[threadId]?.artifacts.length ?? s.threads[threadId]?.artifactCount ?? 0,
  );
  const unread = useAgentStore((s) => {
    const taskId = s.details[threadId]?.taskId ?? s.threads[threadId]?.taskId;
    return taskId ? (findRecordIn(s.records, taskId)?.unread ?? 0) : 0;
  });
  const selected = useUiStore((s) => s.threadTab);
  const tab: ThreadTab =
    (selected === "browser" && !surfaces.includes("browser")) ||
    (selected === "computer" && !surfaces.includes("computer"))
      ? "chat"
      : selected;

  useEffect(() => {
    void agent.loadThread(threadId);
  }, [agent, threadId]);

  useLayoutEffect(() => {
    if (loaded && perfPending("thread:open")) perfEndAfterPaint("thread:open");
  }, [loaded]);

  // New agent messages while the thread is on screen count as read.
  useEffect(() => {
    if (unread > 0 && document.visibilityState === "visible") agent.markRead(threadId);
  }, [agent, threadId, unread]);

  const tabs: Array<{ key: ThreadTab; label: string; count?: number }> = [
    { key: "chat", label: "Chat" },
    { key: "artifacts", label: "Artifacts", count: artifactCount },
  ];
  if (surfaces.includes("browser")) tabs.push({ key: "browser", label: "Browser" });
  if (surfaces.includes("computer")) tabs.push({ key: "computer", label: "Computer" });

  return (
    <div className="thread-view" data-testid="thread-view" data-thread-id={threadId}>
      <ThreadHeader threadId={threadId} />
      <div className="thread-tabs" role="tablist" aria-label="Thread views">
        {tabs.map(({ key, label, count }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={cx("thread-tab", tab === key && "is-active")}
            onClick={() => ui.set({ threadTab: key })}
            data-testid={`thread-tab-${key}`}
          >
            {label}
            {count ? <span className="thread-tab-count">{count}</span> : null}
          </button>
        ))}
      </div>
      <div className="thread-body">
        {!loaded ? (
          <div className="thread-loading" aria-busy="true" />
        ) : tab === "chat" ? (
          <ChatTab threadId={threadId} />
        ) : tab === "artifacts" ? (
          <ArtifactsTab threadId={threadId} />
        ) : tab === "browser" ? (
          <BrowserView threadId={threadId} />
        ) : (
          <ComputerView threadId={threadId} />
        )}
      </div>
    </div>
  );
}
