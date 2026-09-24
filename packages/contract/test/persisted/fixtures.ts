/**
 * Golden files in packages/contract/fixtures/persisted/<format>/. Naming is the contract:
 *   v1*.json                 valid current files (`*invalid*`: some entries must be dropped)
 *   legacy-unversioned*.json files written before formats carried `version`
 *   corrupt*.json            must be quarantined, never loaded
 *   future-version*.json     written by a newer app: must be left untouched
 * Shared with the owner modules' tests, which load them through the real loaders.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/persisted/", import.meta.url));

export type FixtureFormat = "threads" | "records" | "approvals" | "task-state" | "settings";
export type FixtureKind = "v1" | "legacy" | "corrupt" | "future";

export const FIXTURE_FORMATS: readonly FixtureFormat[] = [
  "threads",
  "records",
  "approvals",
  "task-state",
  "settings",
];

export function fixtureKind(name: string): FixtureKind | null {
  if (name.startsWith("v1")) return "v1";
  if (name.startsWith("legacy-unversioned")) return "legacy";
  if (name.startsWith("corrupt")) return "corrupt";
  if (name.startsWith("future-version")) return "future";
  return null;
}

export function listFixtures(format: FixtureFormat): string[] {
  return readdirSync(`${FIXTURES_DIR}${format}`)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/** Decoded as UTF-8 text, exactly like the storage providers do (a BOM stays in the string). */
export function readFixture(format: FixtureFormat | "artifacts", name: string): string {
  return readFileSync(`${FIXTURES_DIR}${format}/${name}`, "utf8");
}
