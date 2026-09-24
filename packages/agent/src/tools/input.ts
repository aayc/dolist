import { errorResult, type ToolResult } from "@ddl/core";

/** Invalid tool input or a request the tool cannot honor; surfaced to the model as an error result. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export type ToolInput = Record<string, unknown>;

export function asInput(input: unknown): ToolInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("Expected a JSON object with the tool's parameters.");
  }
  return input as ToolInput;
}

interface StringRules {
  maxLength?: number;
}

export function requireString(input: ToolInput, key: string, rules: StringRules = {}): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolInputError(`"${key}" is required and must be a non-empty string.`);
  }
  return clamp(value.trim(), key, rules);
}

export function optionalString(
  input: ToolInput,
  key: string,
  rules: StringRules = {},
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolInputError(`"${key}" must be a string.`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : clamp(trimmed, key, rules);
}

export function requireEnum<T extends string>(
  input: ToolInput,
  key: string,
  values: readonly T[],
): T {
  const value = input[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ToolInputError(`"${key}" must be one of: ${values.join(", ")}.`);
  }
  return value as T;
}

export function requireEnumArray<T extends string>(
  input: ToolInput,
  key: string,
  values: readonly T[],
): T[] {
  const value = input[key];
  if (!Array.isArray(value)) {
    throw new ToolInputError(`"${key}" must be an array of: ${values.join(", ")}.`);
  }
  const out: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !values.includes(item as T)) {
      throw new ToolInputError(
        `"${key}" contains "${String(item)}"; allowed: ${values.join(", ")}.`,
      );
    }
    if (!out.includes(item as T)) out.push(item as T);
  }
  return out;
}

export function optionalInt(
  input: ToolInput,
  key: string,
  bounds: { min: number; max: number },
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolInputError(`"${key}" must be a number.`);
  }
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

function clamp(value: string, key: string, rules: StringRules): string {
  if (rules.maxLength !== undefined && value.length > rules.maxLength) {
    throw new ToolInputError(`"${key}" is too long (max ${rules.maxLength} characters).`);
  }
  return value;
}

/** Runs a tool body, turning `ToolInputError`s into error results the model can react to. */
export async function guarded(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof ToolInputError) return errorResult(error.message);
    throw error;
  }
}
