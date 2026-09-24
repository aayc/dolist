import { reportError } from "../lib/report-error";
import { type Hotkey, type KeyLike, matchHotkey } from "./hotkeys";

export interface CommandContext {
  /** The keyboard event that triggered the command (absent when run from the palette). */
  event?: KeyboardEvent;
}

export interface Command {
  id: string;
  name: string;
  hotkeys?: readonly Hotkey[];
  /** Hidden from the command palette (still reachable by hotkey). */
  hidden?: boolean;
  /** When this returns false the hotkey is not consumed and the command is not listed. */
  when?: () => boolean;
  run(context: CommandContext): void | Promise<void>;
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  register(command: Command): () => void {
    if (this.commands.has(command.id)) throw new Error(`Duplicate command id "${command.id}"`);
    this.commands.set(command.id, command);
    return () => {
      if (this.commands.get(command.id) === command) this.commands.delete(command.id);
    };
  }

  registerAll(commands: readonly Command[]): () => void {
    const disposers = commands.map((c) => this.register(c));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  all(): Command[] {
    return [...this.commands.values()];
  }

  /** Commands for the palette: visible and currently applicable. */
  list(): Command[] {
    return this.all().filter((c) => !c.hidden && (c.when?.() ?? true));
  }

  findByEvent(event: KeyLike, isMac: boolean): Command | undefined {
    for (const command of this.commands.values()) {
      if (!command.hotkeys?.some((h) => matchHotkey(h, event, isMac))) continue;
      if (command.when && !command.when()) continue;
      return command;
    }
    return undefined;
  }

  run(id: string, context: CommandContext = {}): boolean {
    const command = this.commands.get(id);
    if (!command || (command.when && !command.when())) return false;
    void Promise.resolve(command.run(context)).catch(reportError);
    return true;
  }
}
