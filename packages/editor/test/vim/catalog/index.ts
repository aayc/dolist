/** The hand-authored vector catalog (see README.md). Case names are unique and stable. */
import type { CaseSpec } from "../format";
import { Catalog, type ThrowingCase } from "./builder";
import { addEdits } from "./edits";
import { addEx } from "./ex";
import { addInsert } from "./insert";
import { addMappings } from "./mappings";
import { addMotions } from "./motions";
import { addNavigation } from "./navigation";
import { addOperators } from "./operators";
import { addRegisters } from "./registers";
import { addRepeat } from "./repeat";
import { addTextObjects } from "./text-objects";
import { addViewport } from "./viewport";
import { addVisual } from "./visual";

export interface BuiltCatalog {
  cases: CaseSpec[];
  throwing: ThrowingCase[];
}

export function buildCatalog(): BuiltCatalog {
  const catalog = new Catalog();
  addMotions(catalog);
  addOperators(catalog);
  addTextObjects(catalog);
  addVisual(catalog);
  addInsert(catalog);
  addEdits(catalog);
  addRegisters(catalog);
  addNavigation(catalog);
  addRepeat(catalog);
  addEx(catalog);
  addMappings(catalog);
  addViewport(catalog);
  return { cases: catalog.all(), throwing: catalog.allThrowing() };
}
