import { createId } from "@ddl/core";
import { create } from "zustand";

export type ToastKind = "info" | "success" | "warning" | "error" | "approval";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  /** Clicking the toast body runs this (e.g. open the thread / conflict copy). */
  onClick?: () => void;
  actionLabel?: string;
  /** 0 = sticky until dismissed. */
  timeoutMs: number;
}

export interface ToastState {
  toasts: readonly Toast[];
}

export const useToastStore = create<ToastState>(() => ({ toasts: [] }));

const MAX_TOASTS = 4;

export function toast(
  input: Omit<Toast, "id" | "timeoutMs"> & { timeoutMs?: number; id?: string },
) {
  const id = input.id ?? createId("toast", 8);
  const item: Toast = { timeoutMs: input.kind === "error" ? 8000 : 5000, ...input, id };
  useToastStore.setState((s) => ({
    toasts: [...s.toasts.filter((t) => t.id !== id), item].slice(-MAX_TOASTS),
  }));
  return id;
}

export function dismissToast(id: string): void {
  useToastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
