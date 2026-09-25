import { toast } from "../state/toast-store";

/** Copies `text`; tells the user when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast({ kind: "error", title: "Couldn't copy to the clipboard" });
    return false;
  }
}
