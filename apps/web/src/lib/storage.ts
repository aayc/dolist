/** localStorage helpers that never throw (private mode, quota, disabled storage in some webviews). */

export function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Persistence is best-effort.
  }
}

export function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence is best-effort.
  }
}

export const STORAGE_KEYS = {
  /** Theme preference read by the inline bootstrap script in index.html. Keep in sync with it. */
  theme: "ddl-theme",
  settingsCache: "ddl-settings-cache",
  layout: "ddl-layout",
  perf: "ddl-perf",
  mockSettings: "ddl-mock-settings",
  /** The mock daemon's vault: the one it serves, and the vaults imported from Obsidian. */
  mockVault: "ddl-mock-vault",
} as const;
