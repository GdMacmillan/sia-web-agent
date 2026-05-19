import { storeEntityTool } from "../../../src/tools/memory-tools.js";
import axios from "axios";

// Mock axios
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("memory-tools relationship suggestions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should suggest related entities and include in response", async () => {
    // Mock search response (first call)
    // Mock store response (second call)
    mockedAxios
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            nodes: [
              {
                id: "conv_001",
                properties: {
                  metadata: {
                    entity_type: "learning",
                    title: "Related Item",
                  },
                },
              },
            ],
          },
        },
      } as any)
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: { id: "conv_123" },
        },
      } as any);

    const result = await storeEntityTool.func({
      entity_type: "learning",
      title: "New Learning",
      content: "Discovered something interesting",
      status: "active",
    });

    const response = JSON.parse(result);

    expect(response.suggested_related_entities).toBeDefined();
    expect(response.suggested_related_entities.length).toBe(1);
    expect(response.suggested_related_entities[0].title).toBe("Related Item");
    expect(response.suggested_related_entities[0].id).toBe("conv_001");
    expect(response.suggestion_note).toContain("semantic similarity");
  });

  it("should filter suggestions by entity_type", async () => {
    // Mock search response with mixed entity types
    mockedAxios
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            nodes: [
              {
                id: "conv_001",
                properties: {
                  metadata: {
                    entity_type: "learning",
                    title: "Match",
                  },
                },
              },
              {
                id: "conv_002",
                properties: {
                  metadata: {
                    entity_type: "idea",
                    title: "Different Type",
                  },
                },
              },
            ],
          },
        },
      } as any)
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: { id: "conv_123" },
        },
      } as any);

    const result = await storeEntityTool.func({
      entity_type: "learning",
      title: "Test",
      content: "Content",
      status: "active",
    });

    const response = JSON.parse(result);

    // Should only suggest learning entities
    expect(response.suggested_related_entities).toBeDefined();
    expect(response.suggested_related_entities.length).toBe(1);
    expect(response.suggested_related_entities[0].title).toBe("Match");
    expect(response.suggested_related_entities[0].entity_type).toBe("learning");

    // Should not include "Different Type" which is an idea
    expect(
      response.suggested_related_entities.some(
        (e: any) => e.title === "Different Type",
      ),
    ).toBe(false);
  });

  it("should warn when no similar entities found", async () => {
    // Mock search response with no results
    mockedAxios
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            nodes: [],
          },
        },
      } as any)
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: { id: "conv_123" },
        },
      } as any);

    const result = await storeEntityTool.func({
      entity_type: "learning",
      title: "First Entry",
      content: "No similar entities exist yet",
      status: "active",
    });

    const response = JSON.parse(result);

    expect(response.suggestion_warning).toContain("No similar entities found");
    expect(response.suggested_related_entities).toBeUndefined();
  });

  it("should handle search errors gracefully", async () => {
    // Mock search response with error (axios throws on error by default)
    mockedAxios
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: { id: "conv_123" },
        },
      } as any);

    const result = await storeEntityTool.func({
      entity_type: "learning",
      title: "Test Entry",
      content: "Should handle errors",
      status: "active",
    });

    const response = JSON.parse(result);

    // Storage should still succeed
    expect(response.message).toContain("stored in graph memory");

    // Should include warning about search failure
    expect(response.suggestion_warning).toContain(
      "Could not search for related entities",
    );
  });

  it("should store relationship data as graph edges when provided", async () => {
    // Mock search response with no results (to simplify)
    mockedAxios
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: { nodes: [] },
        },
      } as any)
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: { id: "conv_123" },
        },
      } as any)
      // Mock edge creation responses
      .mockResolvedValueOnce({
        data: { success: true },
      } as any)
      .mockResolvedValueOnce({
        data: { success: true },
      } as any);

    const _result = await storeEntityTool.func({
      entity_type: "learning",
      title: "Test with relationships",
      content: "Testing relationship storage",
      status: "active",
      related_entity_ids: ["conv_001", "conv_002"],
      relationship_types: ["IMPLEMENTS", "DEPENDS_ON"],
    });

    // Verify that edges were created (calls 3 and 4)
    const calls = mockedAxios.mock.calls;
    expect(calls.length).toBe(4); // search, store, edge1, edge2

    // Check first edge
    const edge1Call = calls[2];
    expect(edge1Call[0]?.url).toContain("/graph/edges");
    expect(edge1Call[0]?.data).toMatchObject({
      from_node_id: "conv_123",
      to_node_id: "conv_001",
      type: "IMPLEMENTS",
    });

    // Check second edge
    const edge2Call = calls[3];
    expect(edge2Call[0]?.url).toContain("/graph/edges");
    expect(edge2Call[0]?.data).toMatchObject({
      from_node_id: "conv_123",
      to_node_id: "conv_002",
      type: "DEPENDS_ON",
    });
  });

  it("should use default RELATED_TO when relationship_types not provided", async () => {
    // Mock search response with no results
    mockedAxios
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: { nodes: [] },
        },
      } as any)
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: { id: "conv_123" },
        },
      } as any)
      // Mock edge creation responses
      .mockResolvedValueOnce({
        data: { success: true },
      } as any)
      .mockResolvedValueOnce({
        data: { success: true },
      } as any);

    const _result = await storeEntityTool.func({
      entity_type: "learning",
      title: "Test with default relationship types",
      content: "Testing default relationship types",
      status: "active",
      related_entity_ids: ["conv_001", "conv_002"],
    });

    // Verify that edges were created with default RELATED_TO type
    const calls = mockedAxios.mock.calls;
    expect(calls.length).toBe(4); // search, store, edge1, edge2

    // Check first edge (should use default RELATED_TO)
    const edge1Call = calls[2];
    expect(edge1Call[0]?.url).toContain("/graph/edges");
    expect(edge1Call[0]?.data).toMatchObject({
      from_node_id: "conv_123",
      to_node_id: "conv_001",
      type: "RELATED_TO",
    });

    // Check second edge (should use default RELATED_TO)
    const edge2Call = calls[3];
    expect(edge2Call[0]?.url).toContain("/graph/edges");
    expect(edge2Call[0]?.data).toMatchObject({
      from_node_id: "conv_123",
      to_node_id: "conv_002",
      type: "RELATED_TO",
    });
  });

  it("should limit suggestions to 5 entities", async () => {
    // Mock search response with many results
    const manyNodes = Array.from({ length: 10 }, (_, i) => ({
      id: `conv_${i.toString().padStart(3, "0")}`,
      properties: {
        metadata: {
          entity_type: "learning",
          title: `Entity ${i}`,
        },
      },
    }));

    mockedAxios
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            nodes: manyNodes,
          },
        },
      } as any)
      .mockResolvedValueOnce({
        data: {
          success: true,
          data: { id: "conv_123" },
        },
      } as any);

    const result = await storeEntityTool.func({
      entity_type: "learning",
      title: "Test",
      content: "Content",
      status: "active",
    });

    const response = JSON.parse(result);

    // Should limit to 5 suggestions
    expect(response.suggested_related_entities).toBeDefined();
    expect(response.suggested_related_entities.length).toBe(5);
  });

  it("should surface edge_errors when backend returns success: false for edge creation", async () => {
    // search returns no results
    mockedAxios
      .mockResolvedValueOnce({
        data: { success: true, data: { nodes: [] } },
      } as any)
      // conversation store succeeds
      .mockResolvedValueOnce({
        data: { success: true, data: { id: "conv_new" } },
      } as any)
      // edge creation returns HTTP 200 but success: false
      .mockResolvedValueOnce({
        data: { success: false, error: "to_node_id conv_xxx not found" },
      } as any);

    const result = await storeEntityTool.func({
      entity_type: "learning",
      title: "Test Entity",
      content: "Content",
      status: "active",
      related_entity_ids: ["conv_xxx"],
      relationship_types: ["EXTENDS"],
    });

    const response = JSON.parse(result);

    expect(response.id).toBe("conv_new");
    expect(response.edge_errors).toBeDefined();
    expect(response.edge_errors).toHaveLength(1);
    expect(response.edge_errors[0].target_id).toBe("conv_xxx");
    expect(response.edge_errors[0].relationship_type).toBe("EXTENDS");
    expect(response.edge_errors[0].error).toBe("to_node_id conv_xxx not found");
    expect(response.edge_warning).toContain("1 of 1 relationship(s)");
    expect(response.edge_warning).toContain("could not be stored");
  });

  it("should surface edge_errors when edge creation throws a network error", async () => {
    mockedAxios
      .mockResolvedValueOnce({
        data: { success: true, data: { nodes: [] } },
      } as any)
      .mockResolvedValueOnce({
        data: { success: true, data: { id: "conv_new" } },
      } as any)
      .mockRejectedValueOnce(new Error("Network timeout"));

    const result = await storeEntityTool.func({
      entity_type: "learning",
      title: "Test Entity",
      content: "Content",
      status: "active",
      related_entity_ids: ["conv_yyy"],
      relationship_types: ["RELATED_TO"],
    });

    const response = JSON.parse(result);

    expect(response.edge_errors).toBeDefined();
    expect(response.edge_errors).toHaveLength(1);
    expect(response.edge_errors[0].target_id).toBe("conv_yyy");
    expect(response.edge_warning).toContain("1 of 1 relationship(s)");
  });
});
