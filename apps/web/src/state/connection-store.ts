import type { HealthResponse } from "@ddl/core";
import { create } from "zustand";
import type { ConnectionState } from "../api/client";

export interface ConnectionStoreState {
  state: ConnectionState;
  endpoint: string;
  health: HealthResponse | null;
  /** Startup could not reach the daemon (shown as a banner until the stream connects). */
  unreachable: boolean;
}

export const useConnectionStore = create<ConnectionStoreState>(() => ({
  state: "connecting",
  endpoint: "",
  health: null,
  unreachable: false,
}));
