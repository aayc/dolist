/**
 * Maps the CLI's streamed message and thought chunks to HarnessEvents. An assistant message runs
 * from its first chunk to the next tool call or the end of the turn, where `message_end` carries
 * its full text; thinking and text of one message share its id, like the Pi harness.
 */
import { createId } from "@ddl/core";
import type { HarnessEvent } from "../types";

export class MessageMapper {
  private readonly newMessageId: () => string;
  private messageId: string | undefined;
  private text = "";

  constructor(newMessageId: () => string = () => createId("msg")) {
    this.newMessageId = newMessageId;
  }

  textDelta(delta: string): HarnessEvent[] {
    if (!delta) return [];
    this.text += delta;
    return [{ type: "text_delta", messageId: this.current(), delta }];
  }

  thinkingDelta(delta: string): HarnessEvent[] {
    if (!delta) return [];
    return [{ type: "thinking_delta", messageId: this.current(), delta }];
  }

  /** Ends the open message (at a tool call or the end of a turn); nothing when none is open. */
  flush(): HarnessEvent[] {
    if (this.messageId === undefined) return [];
    const event: HarnessEvent = { type: "message_end", messageId: this.messageId, text: this.text };
    this.messageId = undefined;
    this.text = "";
    return [event];
  }

  private current(): string {
    this.messageId ??= this.newMessageId();
    return this.messageId;
  }
}
