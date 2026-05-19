/* eslint-disable no-console */
import { storeEntityTool } from "../../../src/tools/memory-tools.js";
import axios from "axios";

// Mock axios
jest.mock("axios");
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe("debug memory-tools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should show actual response", async () => {
    // Mock search response (first call - semantic search for suggestions)
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
      // Mock store response (second call - store the entity)
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

    console.log("Result:", result);
    const response = JSON.parse(result);
    console.log("Parsed response:", JSON.stringify(response, null, 2));

    // Verify the response structure
    expect(response.id).toBe("conv_123");
    expect(response.entity_type).toBe("learning");
    expect(response.title).toBe("New Learning");
    expect(response.status).toBe("created");
    expect(response.suggested_related_entities).toHaveLength(1);
    expect(response.suggested_related_entities[0].id).toBe("conv_001");
  });
});
