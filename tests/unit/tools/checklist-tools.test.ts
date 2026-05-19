import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  createChecklistTools,
  clearChecklists,
  getChecklistStore,
  computeItemStatus,
  topologicalSort,
  validateDependencies,
} from "../../../src/tools/checklist-tools.js";

describe("Checklist Tools", () => {
  let tools: ReturnType<typeof createChecklistTools>;
  let createChecklistTool: any;
  let getChecklistTool: any;
  let checkItemTool: any;
  let uncheckItemTool: any;
  let setDependenciesTool: any;
  let getReadyItemsTool: any;
  let deleteChecklistTool: any;

  beforeEach(() => {
    clearChecklists();
    tools = createChecklistTools();
    [
      createChecklistTool,
      getChecklistTool,
      checkItemTool,
      uncheckItemTool,
      setDependenciesTool,
      getReadyItemsTool,
      deleteChecklistTool,
    ] = tools;
  });

  // Helper: create a checklist and return { checklistId, parsed }
  async function createChecklist(
    threadId: string,
    requirements: (string | { text: string; dependsOn?: number[] })[],
  ) {
    const result = await createChecklistTool.func({ threadId, requirements });
    const parsed = JSON.parse(result);
    return { checklistId: parsed.checklistId, parsed };
  }

  // ---------------------------------------------------------------------------
  // create_checklist
  // ---------------------------------------------------------------------------

  describe("create_checklist", () => {
    it("should create checklist with plain string requirements", async () => {
      const { parsed } = await createChecklist("t1", [
        "Implement login",
        "Add tests",
        "Deploy",
      ]);

      expect(parsed.success).toBe(true);
      expect(parsed.checklistId).toContain("t1");
      expect(parsed.itemCount).toBe(3);
      expect(parsed.items).toHaveLength(3);
      expect(parsed.items[0].requirement).toBe("Implement login");
      expect(parsed.items[0].index).toBe(0);
      expect(parsed.items[0].dependsOn).toEqual([]);
      expect(parsed.items[0].status).toBe("ready");
    });

    it("should generate unique checklist IDs", async () => {
      const { checklistId: id1 } = await createChecklist("t2", ["Task 1"]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const { checklistId: id2 } = await createChecklist("t2", ["Task 2"]);

      expect(id1).not.toBe(id2);
    });

    it("should initialize all items as unchecked", async () => {
      const { checklistId } = await createChecklist("t3", ["Item 1", "Item 2"]);

      const getResult = await getChecklistTool.func({ checklistId });
      const checklist = JSON.parse(getResult);

      expect(checklist.completedCount).toBe(0);
      expect(checklist.allComplete).toBe(false);
    });

    it("should return success response with checklist details", async () => {
      const { parsed } = await createChecklist("t4", ["Req A", "Req B"]);

      expect(parsed).toHaveProperty("success", true);
      expect(parsed).toHaveProperty("checklistId");
      expect(parsed).toHaveProperty("itemCount", 2);
      expect(parsed).toHaveProperty("items");
    });

    it("should handle empty requirements array", async () => {
      const { parsed } = await createChecklist("t5", []);

      expect(parsed.success).toBe(true);
      expect(parsed.itemCount).toBe(0);
      expect(parsed.items).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // create_checklist with dependencies
  // ---------------------------------------------------------------------------

  describe("create_checklist with dependencies", () => {
    it("should create checklist with object-form requirements", async () => {
      const { parsed } = await createChecklist("dep1", [
        { text: "Setup DB", dependsOn: [] },
        { text: "Create schema", dependsOn: [0] },
        { text: "Seed data", dependsOn: [1] },
      ]);

      expect(parsed.success).toBe(true);
      expect(parsed.items[0].dependsOn).toEqual([]);
      expect(parsed.items[1].dependsOn).toEqual([0]);
      expect(parsed.items[2].dependsOn).toEqual([1]);
    });

    it("should accept mixed string and object requirements", async () => {
      const { parsed } = await createChecklist("dep2", [
        "Plain string item",
        { text: "Depends on first", dependsOn: [0] },
      ]);

      expect(parsed.success).toBe(true);
      expect(parsed.items[0].dependsOn).toEqual([]);
      expect(parsed.items[1].dependsOn).toEqual([0]);
    });

    it("should compute initial statuses correctly", async () => {
      const { parsed } = await createChecklist("dep3", [
        { text: "First" },
        { text: "Second", dependsOn: [0] },
        { text: "Third", dependsOn: [1] },
      ]);

      expect(parsed.items[0].status).toBe("ready");
      expect(parsed.items[1].status).toBe("blocked");
      expect(parsed.items[2].status).toBe("blocked");
    });

    it("should reject self-referencing dependencies", async () => {
      const result = await createChecklistTool.func({
        threadId: "dep4",
        requirements: [{ text: "Self ref", dependsOn: [0] }],
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("depends on itself");
    });

    it("should reject invalid dependency indices", async () => {
      const result = await createChecklistTool.func({
        threadId: "dep5",
        requirements: [{ text: "A" }, { text: "B", dependsOn: [99] }],
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("invalid index");
    });

    it("should reject dependency cycles", async () => {
      const result = await createChecklistTool.func({
        threadId: "dep6",
        requirements: [
          { text: "A", dependsOn: [1] },
          { text: "B", dependsOn: [0] },
        ],
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("cycle");
    });

    it("should allow diamond dependency patterns", async () => {
      const { parsed } = await createChecklist("dep7", [
        { text: "Root" },
        { text: "Left", dependsOn: [0] },
        { text: "Right", dependsOn: [0] },
        { text: "Join", dependsOn: [1, 2] },
      ]);

      expect(parsed.success).toBe(true);
      expect(parsed.items[3].dependsOn).toEqual([1, 2]);
      expect(parsed.items[3].status).toBe("blocked");
    });
  });

  // ---------------------------------------------------------------------------
  // get_checklist
  // ---------------------------------------------------------------------------

  describe("get_checklist", () => {
    it("should retrieve existing checklist", async () => {
      const { checklistId } = await createChecklist("g1", [
        "Task A",
        "Task B",
        "Task C",
      ]);

      const getResult = await getChecklistTool.func({ checklistId });
      const retrieved = JSON.parse(getResult);

      expect(retrieved.success).toBe(true);
      expect(retrieved.checklistId).toBe(checklistId);
      expect(retrieved.itemCount).toBe(3);
      expect(retrieved.items).toHaveLength(3);
    });

    it("should return error for non-existent checklist", async () => {
      const result = await getChecklistTool.func({
        checklistId: "non-existent-id",
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Checklist not found");
    });

    it("should calculate progress correctly", async () => {
      const { checklistId } = await createChecklist("g2", ["A", "B", "C"]);

      await checkItemTool.func({ checklistId, itemIndex: 0 });

      const getResult = await getChecklistTool.func({ checklistId });
      const checklist = JSON.parse(getResult);

      expect(checklist.completedCount).toBe(1);
      expect(checklist.progress).toBe("1/3");
      expect(checklist.allComplete).toBe(false);
    });

    it("should show allComplete=true when all checked", async () => {
      const { checklistId } = await createChecklist("g3", ["X", "Y"]);

      await checkItemTool.func({ checklistId, itemIndex: 0 });
      await checkItemTool.func({ checklistId, itemIndex: 1 });

      const getResult = await getChecklistTool.func({ checklistId });
      const checklist = JSON.parse(getResult);

      expect(checklist.allComplete).toBe(true);
      expect(checklist.progress).toBe("2/2");
    });
  });

  // ---------------------------------------------------------------------------
  // get_checklist with dependencies
  // ---------------------------------------------------------------------------

  describe("get_checklist with dependencies", () => {
    it("should include status field on each item", async () => {
      const { checklistId } = await createChecklist("gd1", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
      ]);

      const result = await getChecklistTool.func({ checklistId });
      const parsed = JSON.parse(result);

      expect(parsed.items[0].status).toBeDefined();
      expect(parsed.items[1].status).toBeDefined();
    });

    it("should include readyCount and blockedCount", async () => {
      const { checklistId } = await createChecklist("gd2", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
        { text: "C", dependsOn: [1] },
      ]);

      const result = await getChecklistTool.func({ checklistId });
      const parsed = JSON.parse(result);

      expect(parsed.readyCount).toBe(1);
      expect(parsed.blockedCount).toBe(2);
      expect(parsed.completedCount).toBe(0);
    });

    it("should display items in layered order: completed -> ready -> blocked", async () => {
      const { checklistId } = await createChecklist("gd3", [
        { text: "First" },
        { text: "Second", dependsOn: [0] },
        { text: "Third", dependsOn: [1] },
        "Independent",
      ]);

      // Check the first item
      await checkItemTool.func({ checklistId, itemIndex: 0 });

      const result = await getChecklistTool.func({ checklistId });
      const parsed = JSON.parse(result);

      // completed first, then ready, then blocked
      const statuses = parsed.items.map((i: any) => i.status);
      expect(statuses[0]).toBe("completed"); // item 0
      // ready items next (item 1 is now ready since dep 0 is done, item 3 is independent)
      const readyStatuses = statuses.filter((s: string) => s === "ready");
      const blockedStatuses = statuses.filter((s: string) => s === "blocked");
      expect(readyStatuses.length).toBe(2);
      expect(blockedStatuses.length).toBe(1);

      // Verify blocked items come after ready items
      const lastReadyIdx = statuses.lastIndexOf("ready");
      const firstBlockedIdx = statuses.indexOf("blocked");
      if (firstBlockedIdx !== -1) {
        expect(firstBlockedIdx).toBeGreaterThan(lastReadyIdx);
      }
    });

    it("should include dependsOn in output items", async () => {
      const { checklistId } = await createChecklist("gd4", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
      ]);

      const result = await getChecklistTool.func({ checklistId });
      const parsed = JSON.parse(result);

      // Find item B by index
      const itemB = parsed.items.find((i: any) => i.index === 1);
      expect(itemB.dependsOn).toEqual([0]);
    });

    it("should emit warnings for completed items with unmet deps", async () => {
      const { checklistId } = await createChecklist("gd5", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
      ]);

      // Check A then B (valid)
      await checkItemTool.func({ checklistId, itemIndex: 0 });
      await checkItemTool.func({ checklistId, itemIndex: 1 });

      // Uncheck A — B is now completed with unmet dep
      await uncheckItemTool.func({ checklistId, itemIndex: 0 });

      const result = await getChecklistTool.func({ checklistId });
      const parsed = JSON.parse(result);

      expect(parsed.warnings).toBeDefined();
      expect(parsed.warnings.length).toBeGreaterThan(0);
      expect(parsed.warnings[0]).toContain("Item 1");
    });

    it("should not include warnings when all deps are satisfied", async () => {
      const { checklistId } = await createChecklist("gd6", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
      ]);

      await checkItemTool.func({ checklistId, itemIndex: 0 });

      const result = await getChecklistTool.func({ checklistId });
      const parsed = JSON.parse(result);

      expect(parsed.warnings).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // check_item
  // ---------------------------------------------------------------------------

  describe("check_item", () => {
    it("should mark item as checked", async () => {
      const { checklistId } = await createChecklist("c1", ["Item 1", "Item 2"]);

      const checkResult = await checkItemTool.func({
        checklistId,
        itemIndex: 0,
      });
      const checked = JSON.parse(checkResult);

      expect(checked.success).toBe(true);
      expect(checked.itemIndex).toBe(0);
      expect(checked.requirement).toBe("Item 1");
    });

    it("should add timestamp when checking item", async () => {
      const { checklistId } = await createChecklist("c2", ["Task"]);

      await checkItemTool.func({ checklistId, itemIndex: 0 });

      const getResult = await getChecklistTool.func({ checklistId });
      const checklist = JSON.parse(getResult);

      const item = checklist.items.find((i: any) => i.index === 0);
      expect(item.timestamp).toBeDefined();
      expect(typeof item.timestamp).toBe("string");
    });

    it("should return error for invalid index", async () => {
      const { checklistId } = await createChecklist("c3", ["A", "B"]);

      const result = await checkItemTool.func({ checklistId, itemIndex: 5 });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Invalid item index");
    });

    it("should return error for non-existent checklist", async () => {
      const result = await checkItemTool.func({
        checklistId: "fake-id",
        itemIndex: 0,
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Checklist not found");
    });

    it("should update checklist updatedAt timestamp", async () => {
      const { checklistId } = await createChecklist("c4", ["Task"]);

      const store = getChecklistStore();
      const originalUpdatedAt = store.get(checklistId)?.updatedAt;

      await new Promise((resolve) => setTimeout(resolve, 10));
      await checkItemTool.func({ checklistId, itemIndex: 0 });

      expect(store.get(checklistId)?.updatedAt).not.toBe(originalUpdatedAt);
    });
  });

  // ---------------------------------------------------------------------------
  // check_item with dependencies
  // ---------------------------------------------------------------------------

  describe("check_item with dependencies", () => {
    it("should reject when dependencies are unmet", async () => {
      const { checklistId } = await createChecklist("cd1", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
      ]);

      const result = await checkItemTool.func({
        checklistId,
        itemIndex: 1,
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("unmet dependencies");
      expect(parsed.unmetDependencies).toBeDefined();
      expect(parsed.unmetDependencies[0].index).toBe(0);
    });

    it("should allow checking when all deps are met", async () => {
      const { checklistId } = await createChecklist("cd2", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
      ]);

      await checkItemTool.func({ checklistId, itemIndex: 0 });
      const result = await checkItemTool.func({
        checklistId,
        itemIndex: 1,
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
    });

    it("should report all unmet dependencies", async () => {
      const { checklistId } = await createChecklist("cd3", [
        { text: "A" },
        { text: "B" },
        { text: "C", dependsOn: [0, 1] },
      ]);

      const result = await checkItemTool.func({
        checklistId,
        itemIndex: 2,
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.unmetDependencies).toHaveLength(2);
    });

    it("should allow checking items with no dependencies freely", async () => {
      const { checklistId } = await createChecklist("cd4", [
        { text: "Independent A" },
        { text: "Independent B" },
      ]);

      const result = await checkItemTool.func({
        checklistId,
        itemIndex: 1,
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // uncheck_item
  // ---------------------------------------------------------------------------

  describe("uncheck_item", () => {
    it("should mark item as unchecked", async () => {
      const { checklistId } = await createChecklist("u1", ["Item"]);

      await checkItemTool.func({ checklistId, itemIndex: 0 });
      const uncheckResult = await uncheckItemTool.func({
        checklistId,
        itemIndex: 0,
      });
      const unchecked = JSON.parse(uncheckResult);

      expect(unchecked.success).toBe(true);
    });

    it("should remove timestamp when unchecking", async () => {
      const { checklistId } = await createChecklist("u2", ["Task"]);

      await checkItemTool.func({ checklistId, itemIndex: 0 });
      await uncheckItemTool.func({ checklistId, itemIndex: 0 });

      const getResult = await getChecklistTool.func({ checklistId });
      const checklist = JSON.parse(getResult);

      const item = checklist.items.find((i: any) => i.index === 0);
      expect(item.timestamp).toBeUndefined();
    });

    it("should return error for invalid index", async () => {
      const { checklistId } = await createChecklist("u3", ["A"]);

      const result = await uncheckItemTool.func({
        checklistId,
        itemIndex: 10,
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Invalid item index");
    });

    it("should return error for non-existent checklist", async () => {
      const result = await uncheckItemTool.func({
        checklistId: "bad-id",
        itemIndex: 0,
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Checklist not found");
    });
  });

  // ---------------------------------------------------------------------------
  // uncheck_item cascade warnings
  // ---------------------------------------------------------------------------

  describe("uncheck_item cascade warnings", () => {
    it("should warn about downstream completed items", async () => {
      const { checklistId } = await createChecklist("uw1", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
      ]);

      await checkItemTool.func({ checklistId, itemIndex: 0 });
      await checkItemTool.func({ checklistId, itemIndex: 1 });

      const result = await uncheckItemTool.func({
        checklistId,
        itemIndex: 0,
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.warnings).toBeDefined();
      expect(parsed.warnings.length).toBe(1);
      expect(parsed.warnings[0]).toContain("Item 1");
    });

    it("should not auto-uncheck downstream items", async () => {
      const { checklistId } = await createChecklist("uw2", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
      ]);

      await checkItemTool.func({ checklistId, itemIndex: 0 });
      await checkItemTool.func({ checklistId, itemIndex: 1 });
      await uncheckItemTool.func({ checklistId, itemIndex: 0 });

      // B should still be checked (soft cascade)
      const store = getChecklistStore();
      const checklist = store.get(checklistId);
      expect(checklist?.items[1].checked).toBe(true);
    });

    it("should not emit warnings when no downstream items are completed", async () => {
      const { checklistId } = await createChecklist("uw3", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
      ]);

      await checkItemTool.func({ checklistId, itemIndex: 0 });

      // B is not checked, so unchecking A should have no warnings
      const result = await uncheckItemTool.func({
        checklistId,
        itemIndex: 0,
      });
      const parsed = JSON.parse(result);

      expect(parsed.warnings).toBeUndefined();
    });

    it("should warn about multiple downstream items", async () => {
      const { checklistId } = await createChecklist("uw4", [
        { text: "Root" },
        { text: "Child A", dependsOn: [0] },
        { text: "Child B", dependsOn: [0] },
      ]);

      await checkItemTool.func({ checklistId, itemIndex: 0 });
      await checkItemTool.func({ checklistId, itemIndex: 1 });
      await checkItemTool.func({ checklistId, itemIndex: 2 });

      const result = await uncheckItemTool.func({
        checklistId,
        itemIndex: 0,
      });
      const parsed = JSON.parse(result);

      expect(parsed.warnings).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // set_dependencies
  // ---------------------------------------------------------------------------

  describe("set_dependencies", () => {
    it("should set dependencies on an item", async () => {
      const { checklistId } = await createChecklist("sd1", ["A", "B", "C"]);

      const result = await setDependenciesTool.func({
        checklistId,
        itemIndex: 2,
        dependsOn: [0, 1],
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.dependsOn).toEqual([0, 1]);
      expect(parsed.status).toBe("blocked");
    });

    it("should reject self-referencing dependencies", async () => {
      const { checklistId } = await createChecklist("sd2", ["A", "B"]);

      const result = await setDependenciesTool.func({
        checklistId,
        itemIndex: 0,
        dependsOn: [0],
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("depends on itself");
    });

    it("should reject invalid indices", async () => {
      const { checklistId } = await createChecklist("sd3", ["A"]);

      const result = await setDependenciesTool.func({
        checklistId,
        itemIndex: 0,
        dependsOn: [5],
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("invalid index");
    });

    it("should detect cycles", async () => {
      const { checklistId } = await createChecklist("sd4", [
        { text: "A", dependsOn: [1] },
        { text: "B" },
      ]);

      // Try to make B depend on A (creating A->B->A cycle)
      const result = await setDependenciesTool.func({
        checklistId,
        itemIndex: 1,
        dependsOn: [0],
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("cycle");
    });

    it("should clear dependencies with empty array", async () => {
      const { checklistId } = await createChecklist("sd5", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
      ]);

      const result = await setDependenciesTool.func({
        checklistId,
        itemIndex: 1,
        dependsOn: [],
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.dependsOn).toEqual([]);
      expect(parsed.status).toBe("ready");
    });

    it("should rollback on validation failure", async () => {
      const { checklistId } = await createChecklist("sd6", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
      ]);

      // Try to set invalid deps (self-ref)
      await setDependenciesTool.func({
        checklistId,
        itemIndex: 1,
        dependsOn: [1],
      });

      // Original deps should be preserved
      const store = getChecklistStore();
      const checklist = store.get(checklistId);
      expect(checklist?.items[1].dependsOn).toEqual([0]);
    });

    it("should return error for non-existent checklist", async () => {
      const result = await setDependenciesTool.func({
        checklistId: "nope",
        itemIndex: 0,
        dependsOn: [],
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Checklist not found");
    });
  });

  // ---------------------------------------------------------------------------
  // get_ready_items
  // ---------------------------------------------------------------------------

  describe("get_ready_items", () => {
    it("should return only ready items", async () => {
      const { checklistId } = await createChecklist("gr1", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
        { text: "C" },
      ]);

      const result = await getReadyItemsTool.func({ checklistId });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(true);
      expect(parsed.readyCount).toBe(2);
      const indices = parsed.items.map((i: any) => i.index);
      expect(indices).toContain(0);
      expect(indices).toContain(2);
      expect(indices).not.toContain(1);
    });

    it("should return empty when all items are blocked or completed", async () => {
      const { checklistId } = await createChecklist("gr2", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
      ]);

      // Check A -> completes it; B becomes ready but still unchecked
      await checkItemTool.func({ checklistId, itemIndex: 0 });
      await checkItemTool.func({ checklistId, itemIndex: 1 });

      const result = await getReadyItemsTool.func({ checklistId });
      const parsed = JSON.parse(result);

      expect(parsed.readyCount).toBe(0);
      expect(parsed.items).toHaveLength(0);
    });

    it("should update as items get checked", async () => {
      const { checklistId } = await createChecklist("gr3", [
        { text: "A" },
        { text: "B", dependsOn: [0] },
        { text: "C", dependsOn: [0] },
      ]);

      // Initially only A is ready
      let result = await getReadyItemsTool.func({ checklistId });
      let parsed = JSON.parse(result);
      expect(parsed.readyCount).toBe(1);

      // Check A -> B and C become ready
      await checkItemTool.func({ checklistId, itemIndex: 0 });

      result = await getReadyItemsTool.func({ checklistId });
      parsed = JSON.parse(result);
      expect(parsed.readyCount).toBe(2);
    });

    it("should return error for non-existent checklist", async () => {
      const result = await getReadyItemsTool.func({
        checklistId: "missing",
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Checklist not found");
    });
  });

  // ---------------------------------------------------------------------------
  // delete_checklist
  // ---------------------------------------------------------------------------

  describe("delete_checklist", () => {
    it("should delete existing checklist", async () => {
      const { checklistId } = await createChecklist("d1", ["Task"]);

      const deleteResult = await deleteChecklistTool.func({ checklistId });
      const deleted = JSON.parse(deleteResult);

      expect(deleted.success).toBe(true);
      expect(deleted.checklistId).toBe(checklistId);
    });

    it("should return error for non-existent checklist", async () => {
      const result = await deleteChecklistTool.func({
        checklistId: "missing-id",
      });
      const parsed = JSON.parse(result);

      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Checklist not found");
    });

    it("should remove checklist from store", async () => {
      const { checklistId } = await createChecklist("d2", ["Task"]);

      await deleteChecklistTool.func({ checklistId });

      const getResult = await getChecklistTool.func({ checklistId });
      const get = JSON.parse(getResult);

      expect(get.success).toBe(false);
      expect(get.error).toContain("Checklist not found");
    });
  });

  // ---------------------------------------------------------------------------
  // thread isolation
  // ---------------------------------------------------------------------------

  describe("thread isolation", () => {
    it("should keep checklists isolated by threadId", async () => {
      const { checklistId: id1 } = await createChecklist("thread-A", [
        "Task A",
      ]);
      const { checklistId: id2 } = await createChecklist("thread-B", [
        "Task B",
      ]);

      expect(id1).toContain("thread-A");
      expect(id2).toContain("thread-B");
      expect(id1).not.toBe(id2);
    });

    it("should allow multiple checklists per thread", async () => {
      const { checklistId: id1 } = await createChecklist("thread-C", [
        "Task 1",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const { checklistId: id2 } = await createChecklist("thread-C", [
        "Task 2",
      ]);

      expect(id1).toContain("thread-C");
      expect(id2).toContain("thread-C");
      expect(id1).not.toBe(id2);
    });
  });

  // ---------------------------------------------------------------------------
  // topologicalSort (internal)
  // ---------------------------------------------------------------------------

  describe("topologicalSort", () => {
    it("should handle items with no dependencies", () => {
      const items = [
        { index: 0, requirement: "A", checked: false },
        { index: 1, requirement: "B", checked: false },
        { index: 2, requirement: "C", checked: false },
      ];

      const result = topologicalSort(items);
      expect(result.hasCycle).toBe(false);
      expect(result.sorted).toHaveLength(3);
    });

    it("should sort a linear chain correctly", () => {
      const items = [
        { index: 0, requirement: "A", checked: false },
        { index: 1, requirement: "B", checked: false, dependsOn: [0] },
        { index: 2, requirement: "C", checked: false, dependsOn: [1] },
      ];

      const result = topologicalSort(items);
      expect(result.hasCycle).toBe(false);

      // 0 must come before 1, and 1 before 2
      const pos = new Map(result.sorted.map((idx, i) => [idx, i]));
      expect(pos.get(0)!).toBeLessThan(pos.get(1)!);
      expect(pos.get(1)!).toBeLessThan(pos.get(2)!);
    });

    it("should handle diamond dependency pattern", () => {
      const items = [
        { index: 0, requirement: "Root", checked: false },
        { index: 1, requirement: "Left", checked: false, dependsOn: [0] },
        { index: 2, requirement: "Right", checked: false, dependsOn: [0] },
        {
          index: 3,
          requirement: "Join",
          checked: false,
          dependsOn: [1, 2],
        },
      ];

      const result = topologicalSort(items);
      expect(result.hasCycle).toBe(false);

      const pos = new Map(result.sorted.map((idx, i) => [idx, i]));
      expect(pos.get(0)!).toBeLessThan(pos.get(1)!);
      expect(pos.get(0)!).toBeLessThan(pos.get(2)!);
      expect(pos.get(1)!).toBeLessThan(pos.get(3)!);
      expect(pos.get(2)!).toBeLessThan(pos.get(3)!);
    });

    it("should detect a simple cycle", () => {
      const items = [
        { index: 0, requirement: "A", checked: false, dependsOn: [1] },
        { index: 1, requirement: "B", checked: false, dependsOn: [0] },
      ];

      const result = topologicalSort(items);
      expect(result.hasCycle).toBe(true);
    });

    it("should detect an indirect cycle", () => {
      const items = [
        { index: 0, requirement: "A", checked: false, dependsOn: [2] },
        { index: 1, requirement: "B", checked: false, dependsOn: [0] },
        { index: 2, requirement: "C", checked: false, dependsOn: [1] },
      ];

      const result = topologicalSort(items);
      expect(result.hasCycle).toBe(true);
    });

    it("should handle empty items array", () => {
      const result = topologicalSort([]);
      expect(result.hasCycle).toBe(false);
      expect(result.sorted).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // validateDependencies (internal)
  // ---------------------------------------------------------------------------

  describe("validateDependencies", () => {
    it("should return null for valid dependencies", () => {
      const items = [
        { index: 0, requirement: "A", checked: false },
        { index: 1, requirement: "B", checked: false, dependsOn: [0] },
      ];

      expect(validateDependencies(items)).toBeNull();
    });

    it("should detect self-references", () => {
      const items = [
        { index: 0, requirement: "A", checked: false, dependsOn: [0] },
      ];

      const error = validateDependencies(items);
      expect(error).toContain("depends on itself");
    });

    it("should detect invalid indices", () => {
      const items = [
        { index: 0, requirement: "A", checked: false, dependsOn: [5] },
      ];

      const error = validateDependencies(items);
      expect(error).toContain("invalid index");
    });

    it("should detect cycles", () => {
      const items = [
        { index: 0, requirement: "A", checked: false, dependsOn: [1] },
        { index: 1, requirement: "B", checked: false, dependsOn: [0] },
      ];

      const error = validateDependencies(items);
      expect(error).toContain("cycle");
    });

    it("should return null for items with no dependencies", () => {
      const items = [
        { index: 0, requirement: "A", checked: false },
        { index: 1, requirement: "B", checked: false },
      ];

      expect(validateDependencies(items)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // computeItemStatus (internal)
  // ---------------------------------------------------------------------------

  describe("computeItemStatus", () => {
    it("should return 'completed' for checked items", () => {
      const items = [{ index: 0, requirement: "A", checked: true }];
      expect(computeItemStatus(items[0], items)).toBe("completed");
    });

    it("should return 'ready' for unchecked items with no deps", () => {
      const items = [{ index: 0, requirement: "A", checked: false }];
      expect(computeItemStatus(items[0], items)).toBe("ready");
    });

    it("should return 'ready' when all deps are checked", () => {
      const items = [
        { index: 0, requirement: "A", checked: true },
        { index: 1, requirement: "B", checked: false, dependsOn: [0] },
      ];
      expect(computeItemStatus(items[1], items)).toBe("ready");
    });

    it("should return 'blocked' when any dep is unchecked", () => {
      const items = [
        { index: 0, requirement: "A", checked: false },
        { index: 1, requirement: "B", checked: false, dependsOn: [0] },
      ];
      expect(computeItemStatus(items[1], items)).toBe("blocked");
    });

    it("should return 'completed' even with unmet deps (soft cascade)", () => {
      const items = [
        { index: 0, requirement: "A", checked: false },
        { index: 1, requirement: "B", checked: true, dependsOn: [0] },
      ];
      expect(computeItemStatus(items[1], items)).toBe("completed");
    });
  });

  // ---------------------------------------------------------------------------
  // Tool count
  // ---------------------------------------------------------------------------

  describe("tool count", () => {
    it("should return 7 tools", () => {
      expect(tools).toHaveLength(7);
    });

    it("should include all expected tool names", () => {
      const names = tools.map((t) => t.name);
      expect(names).toEqual([
        "create_checklist",
        "get_checklist",
        "check_item",
        "uncheck_item",
        "set_dependencies",
        "get_ready_items",
        "delete_checklist",
      ]);
    });
  });
});
