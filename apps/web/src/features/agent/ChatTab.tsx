import { useMemo } from "react";
import { useThreadMessages } from "../../state/agent-store";
import { ChatFrame, useChat } from "./ChatFrame";
import { chatItems } from "./chat-items";
import { MessageRow } from "./MessageRow";
import { ToolGroup } from "./ToolGroup";

export function ChatTab({ threadId }: { threadId: string }) {
  const messages = useThreadMessages(threadId);
  const items = useMemo(() => chatItems(messages), [messages]);
  const chat = useChat(threadId, messages, items.length);
  return (
    <ChatFrame chat={chat}>
      {items
        .slice(chat.scroll.start)
        .map((item) =>
          item.kind === "tools" ? (
            <ToolGroup key={`tools:${item.id}`} calls={item.calls} />
          ) : (
            <MessageRow
              key={item.message.id}
              threadId={threadId}
              message={item.message}
              live={!chat.seen.has(item.message.id)}
            />
          ),
        )}
    </ChatFrame>
  );
}
