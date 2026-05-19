/**
 * Native Checklist Tools
 *
 * Provides requirement tracking with dependency-aware scheduling for multi-agent workflows.
 * These are native DynamicStructuredTools that share state via in-memory Map.
 *
 * Status is computed, not stored:
 * - 'completed' = item.checked === true
 * - 'ready'     = not checked AND all dependencies are checked
 * - 'blocked'   = not checked AND at least one dependency is unchecked
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

/** Computed status for a checklist item */
export type ItemStatus = "ready" | "blocked" | "completed";

/** Checklist item structure */
interface ChecklistItem {
  index: number;
  requirement: string;
  checked: boolean;
  timestamp?: string;
  dependsOn?: number[];
}

/** Checklist structure */
interface Checklist {
  id: string;
  threadId: string;
  items: ChecklistItem[];
  createdAt: string;
  updatedAt: string;
}

// In-memory storage: Map<checklistId, Checklist>
// Shared across all agent instances in the same process
const checklists = new Map<string, Checklist>();

// Helper to generate checklist ID
function generateChecklistId(threadId: string): string {
  return `${threadId}_${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Pure utility functions (exported for testing via @internal)
// ---------------------------------------------------------------------------

/**
 * Derive the status of a single item from its checked state and dependency states.
 * @internal Exported for test access
 */
export function computeItemStatus(
  item: ChecklistItem,
  items: ChecklistItem[],
): ItemStatus {
  if (item.checked) return "completed";

  const deps = item.dependsOn ?? [];
  if (deps.length === 0) return "ready";

  const allDepsMet = deps.every(
    (dep) => dep >= 0 && dep < items.length && items[dep].checked,
  );
  return allDepsMet ? "ready" : "blocked";
}

/**
 * Kahn's algorithm for topological sort.
 * Returns sorted indices and whether a cycle was detected.
 * @internal Exported for test access
 */
export function topologicalSort(items: ChecklistItem[]): {
  hasCycle: boolean;
  sorted: number[];
} {
  const n = items.length;
  const inDegree = new Array<number>(n).fill(0);
  const adjacency = new Array<number[]>(n);
  for (let i = 0; i < n; i++) adjacency[i] = [];

  for (let i = 0; i < n; i++) {
    for (const dep of items[i].dependsOn ?? []) {
      if (dep >= 0 && dep < n) {
        adjacency[dep].push(i);
        inDegree[i]++;
      }
    }
  }

  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  const sorted: number[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adjacency[node]) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) queue.push(neighbor);
    }
  }

  return { hasCycle: sorted.length !== n, sorted };
}

/**
 * Validate dependency references: valid indices, no self-refs, no cycles.
 * Returns an error message or null if valid.
 * @internal Exported for test access
 */
export function validateDependencies(items: ChecklistItem[]): string | null {
  const n = items.length;

  for (let i = 0; i < n; i++) {
    const deps = items[i].dependsOn ?? [];
    for (const dep of deps) {
      if (dep === i) {
        return `Item ${i} depends on itself`;
      }
      if (dep < 0 || dep >= n) {
        return `Item ${i} depends on invalid index ${dep} (valid range: 0-${n - 1})`;
      }
    }
  }

  const { hasCycle } = topologicalSort(items);
  if (hasCycle) {
    return "Dependency cycle detected";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Schema for requirement input: supports plain strings and objects with deps
// ---------------------------------------------------------------------------

const requirementSchema = z.union([
  z.string(),
  z.object({
    text: z.string().describe("The requirement text"),
    dependsOn: z
      .array(z.number())
      .optional()
      .describe("Indices of prerequisite items (0-based)"),
  }),
]);

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

function jsonResponse(data: Record<string, unknown>): string {
  return JSON.stringify(data, null, 2);
}

function errorResponse(error: string): string {
  return jsonResponse({ success: false, error });
}

function findChecklist(checklistId: string): Checklist | string {
  const checklist = checklists.get(checklistId);
  if (!checklist) return errorResponse(`Checklist not found: ${checklistId}`);
  return checklist;
}

function validateItemIndex(
  checklist: Checklist,
  itemIndex: number,
): string | null {
  if (itemIndex < 0 || itemIndex >= checklist.items.length) {
    return errorResponse(
      `Invalid item index: ${itemIndex} (checklist has ${checklist.items.length} items)`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create all 7 checklist tools as native DynamicStructuredTools
 */
export function createChecklistTools(): DynamicStructuredTool[] {
  // Tool 1: create_checklist
  const createChecklistTool = new DynamicStructuredTool({
    name: "create_checklist",
    description:
      "Create a new checklist from requirements. Accepts plain strings or objects with dependency info.",
    schema: z.object({
      threadId: z.string().describe("Thread ID for this workflow execution"),
      requirements: z
        .array(requirementSchema)
        .describe(
          "List of requirements — strings or { text, dependsOn? } objects",
        ),
    }),
    func: async ({ threadId, requirements }) => {
      // Normalize mixed input to ChecklistItem[]
      const items: ChecklistItem[] = requirements.map(
        (
          req: string | { text: string; dependsOn?: number[] },
          index: number,
        ) => {
          if (typeof req === "string") {
            return { index, requirement: req, checked: false };
          }
          return {
            index,
            requirement: req.text,
            checked: false,
            dependsOn:
              req.dependsOn && req.dependsOn.length > 0
                ? req.dependsOn
                : undefined,
          };
        },
      );

      // Validate dependencies before persisting
      const validationError = validateDependencies(items);
      if (validationError) {
        return errorResponse(validationError);
      }

      const checklistId = generateChecklistId(threadId);
      const checklist: Checklist = {
        id: checklistId,
        threadId,
        items,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      checklists.set(checklistId, checklist);

      return jsonResponse({
        success: true,
        checklistId,
        itemCount: items.length,
        items: items.map((item) => ({
          index: item.index,
          requirement: item.requirement,
          dependsOn: item.dependsOn ?? [],
          status: computeItemStatus(item, items),
        })),
      });
    },
  });

  // Tool 2: get_checklist
  const getChecklistTool = new DynamicStructuredTool({
    name: "get_checklist",
    description:
      "Retrieve the current state of a checklist with computed statuses and layered display order.",
    schema: z.object({
      checklistId: z.string().describe("The checklist ID to retrieve"),
    }),
    func: async ({ checklistId }) => {
      const result = findChecklist(checklistId);
      if (typeof result === "string") return result;
      const checklist = result;

      const { sorted } = topologicalSort(checklist.items);

      // Compute status for all items
      const itemsWithStatus = checklist.items.map((item) => ({
        index: item.index,
        requirement: item.requirement,
        checked: item.checked,
        status: computeItemStatus(item, checklist.items),
        dependsOn: item.dependsOn ?? [],
        timestamp: item.timestamp,
      }));

      // Layered display order: completed (by timestamp) -> ready (topo) -> blocked (topo)
      const completed = itemsWithStatus
        .filter((i) => i.status === "completed")
        .sort((a, b) => {
          const tA = a.timestamp ?? "";
          const tB = b.timestamp ?? "";
          return tA.localeCompare(tB);
        });

      const topoOrder = new Map(sorted.map((idx, pos) => [idx, pos]));
      const ready = itemsWithStatus
        .filter((i) => i.status === "ready")
        .sort(
          (a, b) =>
            (topoOrder.get(a.index) ?? a.index) -
            (topoOrder.get(b.index) ?? b.index),
        );

      const blocked = itemsWithStatus
        .filter((i) => i.status === "blocked")
        .sort(
          (a, b) =>
            (topoOrder.get(a.index) ?? a.index) -
            (topoOrder.get(b.index) ?? b.index),
        );

      // Warnings: completed items whose deps are now unmet (inconsistency from unchecking)
      const warnings: string[] = [];
      for (const item of checklist.items) {
        if (item.checked && item.dependsOn) {
          const unmet = item.dependsOn.filter(
            (dep) => !checklist.items[dep].checked,
          );
          if (unmet.length > 0) {
            warnings.push(
              `Item ${item.index} ("${item.requirement}") is completed but has unmet dependencies: [${unmet.join(", ")}]`,
            );
          }
        }
      }

      const completedCount = completed.length;
      const readyCount = ready.length;
      const blockedCount = blocked.length;
      const totalCount = checklist.items.length;
      const allComplete = completedCount === totalCount;

      return jsonResponse({
        success: true,
        checklistId: checklist.id,
        threadId: checklist.threadId,
        itemCount: totalCount,
        completedCount,
        readyCount,
        blockedCount,
        progress: `${completedCount}/${totalCount}`,
        allComplete,
        items: [...completed, ...ready, ...blocked],
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    },
  });

  // Tool 3: check_item
  const checkItemTool = new DynamicStructuredTool({
    name: "check_item",
    description:
      "Mark a checklist item as completed. Blocked if unmet dependencies exist.",
    schema: z.object({
      checklistId: z.string().describe("The checklist ID"),
      itemIndex: z
        .number()
        .describe("The index of the item to check off (0-based)"),
    }),
    func: async ({ checklistId, itemIndex }) => {
      const result = findChecklist(checklistId);
      if (typeof result === "string") return result;
      const checklist = result;

      const indexError = validateItemIndex(checklist, itemIndex);
      if (indexError) return indexError;

      const item = checklist.items[itemIndex];

      // Enforce dependency blocking
      if (item.dependsOn && item.dependsOn.length > 0) {
        const unmet = item.dependsOn.filter(
          (dep) => !checklist.items[dep].checked,
        );
        if (unmet.length > 0) {
          return jsonResponse({
            success: false,
            error: `Cannot check item ${itemIndex}: unmet dependencies`,
            unmetDependencies: unmet.map((dep) => ({
              index: dep,
              requirement: checklist.items[dep].requirement,
            })),
          });
        }
      }

      item.checked = true;
      item.timestamp = new Date().toISOString();
      checklist.updatedAt = new Date().toISOString();
      checklists.set(checklistId, checklist);

      return jsonResponse({
        success: true,
        message: `Checked off item ${itemIndex}: ${item.requirement}`,
        itemIndex,
        requirement: item.requirement,
      });
    },
  });

  // Tool 4: uncheck_item
  const uncheckItemTool = new DynamicStructuredTool({
    name: "uncheck_item",
    description:
      "Mark a checklist item as incomplete (uncheck). Warns about downstream completed items with now-unmet deps.",
    schema: z.object({
      checklistId: z.string().describe("The checklist ID"),
      itemIndex: z
        .number()
        .describe("The index of the item to uncheck (0-based)"),
    }),
    func: async ({ checklistId, itemIndex }) => {
      const result = findChecklist(checklistId);
      if (typeof result === "string") return result;
      const checklist = result;

      const indexError = validateItemIndex(checklist, itemIndex);
      if (indexError) return indexError;

      checklist.items[itemIndex].checked = false;
      checklist.items[itemIndex].timestamp = undefined;
      checklist.updatedAt = new Date().toISOString();
      checklists.set(checklistId, checklist);

      // Find downstream completed items that now have unmet deps
      const warnings: string[] = [];
      for (const item of checklist.items) {
        if (
          item.checked &&
          item.dependsOn &&
          item.dependsOn.includes(itemIndex)
        ) {
          warnings.push(
            `Item ${item.index} ("${item.requirement}") is completed but now has unmet dependency on item ${itemIndex}`,
          );
        }
      }

      return jsonResponse({
        success: true,
        message: `Unchecked item ${itemIndex}: ${checklist.items[itemIndex].requirement}`,
        itemIndex,
        requirement: checklist.items[itemIndex].requirement,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    },
  });

  // Tool 5: set_dependencies
  const setDependenciesTool = new DynamicStructuredTool({
    name: "set_dependencies",
    description:
      "Set or update the dependency list for a checklist item. Pass an empty array to clear dependencies.",
    schema: z.object({
      checklistId: z.string().describe("The checklist ID"),
      itemIndex: z
        .number()
        .describe("The index of the item to update (0-based)"),
      dependsOn: z
        .array(z.number())
        .describe(
          "Indices of prerequisite items (0-based). Empty array clears deps.",
        ),
    }),
    func: async ({ checklistId, itemIndex, dependsOn }) => {
      const result = findChecklist(checklistId);
      if (typeof result === "string") return result;
      const checklist = result;

      const indexError = validateItemIndex(checklist, itemIndex);
      if (indexError) return indexError;

      // Save original for rollback
      const originalDeps = checklist.items[itemIndex].dependsOn;

      // Temporarily set new deps
      checklist.items[itemIndex].dependsOn =
        dependsOn.length > 0 ? dependsOn : undefined;

      const validationError = validateDependencies(checklist.items);
      if (validationError) {
        // Rollback
        checklist.items[itemIndex].dependsOn = originalDeps;
        return errorResponse(validationError);
      }

      checklist.updatedAt = new Date().toISOString();
      checklists.set(checklistId, checklist);

      return jsonResponse({
        success: true,
        message: `Updated dependencies for item ${itemIndex}`,
        itemIndex,
        dependsOn: checklist.items[itemIndex].dependsOn ?? [],
        status: computeItemStatus(checklist.items[itemIndex], checklist.items),
      });
    },
  });

  // Tool 6: get_ready_items
  const getReadyItemsTool = new DynamicStructuredTool({
    name: "get_ready_items",
    description:
      "Get all checklist items that are ready to work on (not blocked and not completed).",
    schema: z.object({
      checklistId: z.string().describe("The checklist ID"),
    }),
    func: async ({ checklistId }) => {
      const result = findChecklist(checklistId);
      if (typeof result === "string") return result;
      const checklist = result;

      const readyItems = checklist.items.filter(
        (item) => computeItemStatus(item, checklist.items) === "ready",
      );

      return jsonResponse({
        success: true,
        readyCount: readyItems.length,
        items: readyItems.map((item) => ({
          index: item.index,
          requirement: item.requirement,
        })),
      });
    },
  });

  // Tool 7: delete_checklist
  const deleteChecklistTool = new DynamicStructuredTool({
    name: "delete_checklist",
    description:
      "Delete a checklist when the workflow is complete or cancelled.",
    schema: z.object({
      checklistId: z.string().describe("The checklist ID to delete"),
    }),
    func: async ({ checklistId }) => {
      const existed = checklists.has(checklistId);

      if (!existed) {
        return errorResponse(`Checklist not found: ${checklistId}`);
      }

      checklists.delete(checklistId);

      return jsonResponse({
        success: true,
        message: `Deleted checklist: ${checklistId}`,
        checklistId,
      });
    },
  });

  return [
    createChecklistTool,
    getChecklistTool,
    checkItemTool,
    uncheckItemTool,
    setDependenciesTool,
    getReadyItemsTool,
    deleteChecklistTool,
  ];
}

/**
 * Export for testing/debugging
 */
export function getChecklistStore(): Map<string, Checklist> {
  return checklists;
}

/**
 * Clear all checklists (useful for testing)
 */
export function clearChecklists(): void {
  checklists.clear();
}
