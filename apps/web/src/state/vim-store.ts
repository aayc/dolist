import type { VimrcProblem, VimStatus } from "@ddl/editor";
import { create } from "zustand";

export interface VimState {
  /** Mode, pending keys and macro recording of the editor; null while vim is off. */
  status: VimStatus | null;
  /** Lines of the vimrc vim rejected when it was last applied. */
  vimrcProblems: readonly VimrcProblem[];
}

export const useVimStore = create<VimState>(() => ({ status: null, vimrcProblems: [] }));

/** Called by the editor only when the status changed, never per keystroke in insert mode. */
export function setVimStatus(status: VimStatus | null): void {
  useVimStore.setState({ status });
}

export function setVimrcProblems(problems: readonly VimrcProblem[]): void {
  useVimStore.setState({ vimrcProblems: problems });
}
