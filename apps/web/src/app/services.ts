import type { AppSettings, DeepPartial } from "@ddl/core";
import { createContext, use } from "react";
import type { DaemonClient } from "../api/client";
import { createDefaultCommands } from "../commands/default-commands";
import { CommandRegistry } from "../commands/registry";
import { updateSettings } from "../features/settings/settings-actions";
import { AgentActions } from "./agent-actions";
import { Workspace } from "./workspace";

export interface Services {
  client: DaemonClient;
  workspace: Workspace;
  agent: AgentActions;
  commands: CommandRegistry;
  updateSettings(patch: DeepPartial<AppSettings>): Promise<void>;
}

export function createServices(client: DaemonClient): Services {
  const agent = new AgentActions(client);
  const workspace = new Workspace(client, agent);
  agent.attach({
    openNote: (path, options) => workspace.openNote(path, options),
    activeDocument: () => workspace.editor.getDocument(),
    scrollToLine: (line) => workspace.editor.scrollToLine(line),
  });
  const services: Services = {
    client,
    workspace,
    agent,
    commands: new CommandRegistry(),
    updateSettings: (patch) => updateSettings(client, patch),
  };
  services.commands.registerAll(createDefaultCommands(services));
  workspace.commandRunner = (id) => services.commands.run(id);
  return services;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = use(ServicesContext);
  if (!services) throw new Error("useServices() must be used inside <ServicesContext>");
  return services;
}
