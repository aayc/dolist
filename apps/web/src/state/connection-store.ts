import type { HealthResponse } from "@ddl/core";
import { create } from "zustand";
import type { ClientKind, ConnectionState } from "../api/client";

export interface ConnectionStoreState {
  state: ConnectionState;
  kind: ClientKind | null;
  endpoint: string;
  health: HealthResponse | null;
  /** Startup could not reach the daemon (shown as a banner until the stream connects). */
  unreachable: boolean;
}

export const useConnectionStore = create<ConnectionStoreState>(() => ({
  state: "connecting",
  kind: null,
  endpoint: "",
  health: null,
  unreachable: false,
}));
