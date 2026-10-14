/**
 * Tool-definition budget.
 *
 * Every tool the model can call is re-sent on every turn as a JSON function
 * definition (name + description + parameter schema). That payload is paid for
 * on every call, so it is budgeted: each definition has a character cap, and
 * the set of tools advertised on a turn has a total cap.
 *
 * Measurement serializes a tool the same way the chat-model integrations do
 * (`convertToOpenAITool`), so the numbers are what actually goes over the
 * wire, not an estimate of it. Tokens are approximated as chars / 4.
 *
 * Used by `scripts/measure-prompt-budget.ts` (the report) and by the unit
 * test that enforces the budget.
 */
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { StructuredToolInterface } from "@langchain/core/tools";

/** Default cap on one serialized tool definition, in characters. */
export const DEFAULT_TOOL_BUDGET = 2000;

/**
 * Per-tool caps for tools whose job genuinely needs more explanation.
 * Anything not listed here gets {@link DEFAULT_TOOL_BUDGET}.
 */
export const TOOL_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  bash: 4000,
  task: 4000,
  execute_code: 4000,
  // Seventeen optional parameters, each accepting the loose shapes models
  // send; the schema alone is most of the definition.
  web_search: 2500,
});

/**
 * Cap on the total serialized size of the tools advertised on one model
 * call (tools deferred behind a skill are not advertised until it loads).
 */
export const TOTAL_TOOL_BUDGET = 29_200;

/** The cap that applies to one tool. */
export function budgetFor(name: string): number {
  return TOOL_BUDGETS[name] ?? DEFAULT_TOOL_BUDGET;
}

/** Approximate token count for a character count (chars / 4, rounded up). */
export function approxTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** The wire form of one tool definition, as a JSON string. */
export function serializeToolDefinition(
  tool: StructuredToolInterface | Record<string, unknown>,
): string {
  return JSON.stringify(
    convertToOpenAITool(tool as Parameters<typeof convertToOpenAITool>[0]),
  );
}

export interface ToolMeasurement {
  name: string;
  /** Characters in the full serialized definition. */
  chars: number;
  /** Characters in the top-level description alone. */
  descriptionChars: number;
  /** Characters in the serialized parameter schema. */
  schemaChars: number;
  tokens: number;
  budget: number;
  overBudget: boolean;
}

export interface ToolSetMeasurement {
  tools: ToolMeasurement[];
  totalChars: number;
  totalTokens: number;
  /** Tools whose definition exceeds its own cap. */
  over: ToolMeasurement[];
}

/** Measure a set of tools, largest first. */
export function measureTools(
  tools: ReadonlyArray<StructuredToolInterface | Record<string, unknown>>,
): ToolSetMeasurement {
  const rows = tools.map((tool): ToolMeasurement => {
    const wire = convertToOpenAITool(
      tool as Parameters<typeof convertToOpenAITool>[0],
    );
    const chars = JSON.stringify(wire).length;
    const name = wire.function.name;
    const budget = budgetFor(name);
    return {
      name,
      chars,
      descriptionChars: (wire.function.description ?? "").length,
      schemaChars: JSON.stringify(wire.function.parameters ?? {}).length,
      tokens: approxTokens(chars),
      budget,
      overBudget: chars > budget,
    };
  });
  rows.sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
  const totalChars = rows.reduce((sum, row) => sum + row.chars, 0);
  return {
    tools: rows,
    totalChars,
    totalTokens: approxTokens(totalChars),
    over: rows.filter((row) => row.overBudget),
  };
}
