import { searchParam } from "../lib/platform";
import { readInjectedToken } from "./auth";
import type { DaemonClient } from "./client";
import { HttpDaemonClient } from "./http-client";

export function isMockMode(): boolean {
  return searchParam("mock") === "1" || import.meta.env.VITE_DDL_MOCK === "1";
}

/** The mock (and its seed data/agent simulation) is a separate chunk that never loads in normal mode. */
export async function createDaemonClient(): Promise<DaemonClient> {
  if (isMockMode()) {
    const { MockDaemonClient } = await import("./mock/mock-client");
    const speed = Number(searchParam("mockSpeed"));
    return new MockDaemonClient({ speed: Number.isFinite(speed) && speed > 0 ? speed : 1 });
  }
  return new HttpDaemonClient({ token: readInjectedToken() });
}
