import { Send } from "lucide-react";
import { useState } from "react";
import { useServices } from "../../app/services";
import { IconButton } from "../../components/IconButton";
import { useAgentStore } from "../../state/agent-store";

export function Composer({ threadId }: { threadId: string }) {
  const { agent } = useServices();
  const enabled = useAgentStore((s) => s.status?.enabled ?? true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const message = text.trim();
    if (!message || sending || !enabled) return;
    setSending(true);
    const ok = await agent.postMessage(threadId, message);
    setSending(false);
    if (ok) setText("");
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        className="composer-input"
        value={text}
        rows={1}
        disabled={!enabled}
        placeholder={
          enabled
            ? "Reply to the agent…  (Enter to send, Shift+Enter for a new line)"
            : "The agent is off"
        }
        aria-label="Message the agent"
        data-testid="composer-input"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <IconButton
        icon={Send}
        label="Send"
        type="submit"
        disabled={!enabled || sending || !text.trim()}
        data-testid="composer-send"
      />
    </form>
  );
}
