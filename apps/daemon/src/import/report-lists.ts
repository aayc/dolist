import {
  IMPORT_REPORT_LIMIT,
  type ImportMove,
  type ImportMoveList,
  type ImportPathList,
  type ImportSkipped,
  type ImportSkippedList,
} from "@ddl/core";

/** Counts everything, keeps the first `IMPORT_REPORT_LIMIT` entries (reports stay small). */
export class BoundedList<T> {
  count = 0;
  readonly items: T[] = [];

  add(item: T): void {
    this.count++;
    if (this.items.length < IMPORT_REPORT_LIMIT) this.items.push(item);
  }
}

export function pathList(list: BoundedList<string>): ImportPathList {
  return { count: list.count, paths: [...list.items].sort(compareStrings) };
}

export function moveList(list: BoundedList<ImportMove>): ImportMoveList {
  return {
    count: list.count,
    items: [...list.items].sort((a, b) => compareStrings(a.from, b.from)),
  };
}

export function skippedList(list: BoundedList<ImportSkipped>): ImportSkippedList {
  return {
    count: list.count,
    items: [...list.items].sort((a, b) => compareStrings(a.path, b.path)),
  };
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
