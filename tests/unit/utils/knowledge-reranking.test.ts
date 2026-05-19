/**
 * Knowledge Re-ranking Tests
 * Tests for weighted re-ranking formula:
 * P = w1·Semantic + w2·Recency + w3·AccessCount + w4·SuccessRate + w5·PriorityBoost
 */

import { describe, it, expect } from "@jest/globals";
import {
  rerankEntities,
  rerankEntitiesWithScores,
  calculateSuccessRate,
  calculateRecency,
  calculateAccessCountScore,
  calculatePriorityBoost,
  WEIGHT_PRESETS,
  type RetrievedEntity,
  type RerankingConfig,
} from "../../../src/utils/knowledge-reranking.js";

describe("Knowledge Re-ranking", () => {
  describe("Weight Presets", () => {
    it("should have balanced preset", () => {
      const weights = WEIGHT_PRESETS.balanced;
      expect(weights.semantic).toBe(0.5);
      expect(weights.recency).toBe(0.15);
      expect(weights.accessCount).toBe(0.1);
      expect(weights.successRate).toBe(0.2);
      expect(weights.priorityBoost).toBe(0.05);
    });

    it("should have semantic_heavy preset", () => {
      const weights = WEIGHT_PRESETS.semantic_heavy;
      expect(weights.semantic).toBe(0.7);
      expect(weights.recency).toBe(0.1);
      expect(weights.accessCount).toBe(0.05);
      expect(weights.successRate).toBe(0.1);
      expect(weights.priorityBoost).toBe(0.05);
    });

    it("should have recency_heavy preset", () => {
      const weights = WEIGHT_PRESETS.recency_heavy;
      expect(weights.semantic).toBe(0.35);
      expect(weights.recency).toBe(0.35);
      expect(weights.accessCount).toBe(0.1);
      expect(weights.successRate).toBe(0.15);
      expect(weights.priorityBoost).toBe(0.05);
    });

    it("should have proven_only preset", () => {
      const weights = WEIGHT_PRESETS.proven_only;
      expect(weights.semantic).toBe(0.3);
      expect(weights.recency).toBe(0.1);
      expect(weights.accessCount).toBe(0.1);
      expect(weights.successRate).toBe(0.45);
      expect(weights.priorityBoost).toBe(0.05);
    });

    it("all presets should sum to 1.0", () => {
      Object.values(WEIGHT_PRESETS).forEach((preset) => {
        const sum =
          preset.semantic +
          preset.recency +
          preset.accessCount +
          preset.successRate +
          preset.priorityBoost;
        expect(sum).toBeCloseTo(1.0, 10);
      });
    });
  });

  describe("calculateSuccessRate", () => {
    it("should calculate success rate correctly", () => {
      const metadata = {
        success_count: 7,
        failure_count: 3,
      };

      const rate = calculateSuccessRate(metadata, 3);
      expect(rate).toBe(0.7);
    });

    it("should use 0.5 for cold start (< min applications)", () => {
      const metadata = {
        success_count: 1,
        failure_count: 1, // Only 2 applications
      };

      const rate = calculateSuccessRate(metadata, 3);
      expect(rate).toBe(0.5);
    });

    it("should use actual rate once minimum applications reached", () => {
      const metadata = {
        success_count: 3,
        failure_count: 0, // Exactly 3 applications
      };

      const rate = calculateSuccessRate(metadata, 3);
      expect(rate).toBe(1.0);
    });

    it("should handle zero applications with neutral score", () => {
      const metadata = {
        success_count: 0,
        failure_count: 0,
      };

      const rate = calculateSuccessRate(metadata, 3);
      expect(rate).toBe(0.5);
    });

    it("should handle missing metadata gracefully", () => {
      const metadata = {};

      const rate = calculateSuccessRate(metadata, 3);
      expect(rate).toBe(0.5);
    });
  });

  describe("calculateRecency", () => {
    it("should give score of 1.0 for recently applied (today)", () => {
      const metadata = {
        last_applied_at: new Date().toISOString(),
      };

      const score = calculateRecency(metadata);
      // Score should be very close to 1.0
      expect(score).toBeGreaterThan(0.99);
    });

    it("should decrease score for older applications", () => {
      const oneDayAgo = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString();
      const sevenDaysAgo = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const recentScore = calculateRecency({ last_applied_at: oneDayAgo });
      const oldScore = calculateRecency({ last_applied_at: sevenDaysAgo });

      expect(recentScore).toBeGreaterThan(oldScore);
    });

    it("should use low score (0.1) for never-applied", () => {
      const metadata = {}; // No last_applied_at

      const score = calculateRecency(metadata);
      expect(score).toBe(0.1);
    });

    it("should calculate using 1/(1+days) formula", () => {
      const oneDayAgo = new Date(
        Date.now() - 24 * 60 * 60 * 1000,
      ).toISOString();
      const metadata = { last_applied_at: oneDayAgo };

      const score = calculateRecency(metadata);
      // For 1 day ago: 1 / (1 + 1) = 0.5
      expect(score).toBeCloseTo(0.5, 1);
    });
  });

  describe("calculateAccessCountScore", () => {
    it("should return 0 for zero accesses", () => {
      const metadata = { access_count: 0 };
      const score = calculateAccessCountScore(metadata);
      expect(score).toBe(0);
    });

    it("should return 0 for missing access_count", () => {
      const metadata = {};
      const score = calculateAccessCountScore(metadata);
      expect(score).toBe(0);
    });

    it("should use logarithmic scale", () => {
      // log10(1 + 1) / 2 = log10(2) / 2 ≈ 0.15
      const metadata1 = { access_count: 1 };
      const score1 = calculateAccessCountScore(metadata1);
      expect(score1).toBeCloseTo(0.15, 2);

      // log10(10 + 1) / 2 = log10(11) / 2 ≈ 0.52
      const metadata10 = { access_count: 10 };
      const score10 = calculateAccessCountScore(metadata10);
      expect(score10).toBeCloseTo(0.52, 2);

      // log10(100 + 1) / 2 = log10(101) / 2 ≈ 1.0 (capped)
      const metadata100 = { access_count: 100 };
      const score100 = calculateAccessCountScore(metadata100);
      expect(score100).toBeCloseTo(1.0, 2);
    });

    it("should cap at 1.0 for high access counts", () => {
      const metadata = { access_count: 1000 };
      const score = calculateAccessCountScore(metadata);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it("should increase with more accesses", () => {
      const score1 = calculateAccessCountScore({ access_count: 1 });
      const score10 = calculateAccessCountScore({ access_count: 10 });
      const score100 = calculateAccessCountScore({ access_count: 100 });

      expect(score10).toBeGreaterThan(score1);
      expect(score100).toBeGreaterThan(score10);
    });
  });

  describe("calculatePriorityBoost", () => {
    it("should return 1.0 for high priority", () => {
      const score = calculatePriorityBoost("high");
      expect(score).toBe(1.0);
    });

    it("should return 0.5 for medium priority", () => {
      const score = calculatePriorityBoost("medium");
      expect(score).toBe(0.5);
    });

    it("should return 0.0 for low priority", () => {
      const score = calculatePriorityBoost("low");
      expect(score).toBe(0.0);
    });

    it("should default to 0.5 for undefined priority", () => {
      const score = calculatePriorityBoost(undefined);
      expect(score).toBe(0.5);
    });
  });

  describe("rerankEntities", () => {
    const createEntity = (
      id: string,
      priority: "low" | "medium" | "high" = "medium",
      metadata: Record<string, any> = {},
    ): RetrievedEntity => ({
      id,
      entity_type: "learning",
      title: `Learning ${id}`,
      content: "Test content",
      priority,
      status: "active",
      created_at: new Date().toISOString(),
      metadata,
    });

    describe("basic re-ranking", () => {
      it("should return empty array for empty input", () => {
        const result = rerankEntities([]);
        expect(result).toEqual([]);
      });

      it("should return single entity unchanged", () => {
        const entity = createEntity("1");
        const result = rerankEntities([entity]);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("1");
      });

      it("should re-order entities based on weighted score", () => {
        const now = Date.now();
        const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString();

        const entities = [
          // First in semantic (1.0), but low success, low access, medium priority
          createEntity("low-success", "medium", {
            success_count: 1,
            failure_count: 9,
            last_applied_at: yesterday,
            access_count: 1,
          }),
          // Second in semantic (0.5), high success, high access, high priority, recent
          createEntity("high-success", "high", {
            success_count: 9,
            failure_count: 1,
            last_applied_at: new Date().toISOString(),
            access_count: 50,
          }),
          // Third in semantic (0.0), medium success, medium access, low priority
          createEntity("medium-success", "low", {
            success_count: 5,
            failure_count: 5,
            last_applied_at: yesterday,
            access_count: 10,
          }),
        ];

        const result = rerankEntities(entities);

        // "high-success" should rank first due to better scores across all dimensions
        expect(result[0].id).toBe("high-success");
      });

      it("should accept preset string", () => {
        const entities = [createEntity("1"), createEntity("2")];

        const result = rerankEntities(entities, "semantic_heavy");
        expect(result).toHaveLength(2);
      });

      it("should accept config object", () => {
        const entities = [createEntity("1"), createEntity("2")];

        const config: RerankingConfig = {
          weights: WEIGHT_PRESETS.balanced,
          minApplicationsForRanking: 5,
        };

        const result = rerankEntities(entities, config);
        expect(result).toHaveLength(2);
      });
    });

    describe("semantic scoring", () => {
      it("should assign highest semantic to first entity", () => {
        const entities = [
          createEntity("first"),
          createEntity("second"),
          createEntity("third"),
        ];

        const result = rerankEntitiesWithScores(entities);

        expect(result[0].components.semantic).toBe(1.0);
      });

      it("should assign lowest semantic to last entity", () => {
        const entities = [
          createEntity("first"),
          createEntity("second"),
          createEntity("third"),
        ];

        const result = rerankEntitiesWithScores(entities);

        const lastEntity = result.find((e) => e.entity.id === "third");
        expect(lastEntity?.components.semantic).toBe(0.0);
      });

      it("should interpolate semantic for middle entities", () => {
        const entities = [
          createEntity("first"),
          createEntity("second"),
          createEntity("third"),
        ];

        const result = rerankEntitiesWithScores(entities);

        const middleEntity = result.find((e) => e.entity.id === "second");
        expect(middleEntity?.components.semantic).toBe(0.5);
      });
    });

    describe("weight normalization", () => {
      it("should normalize weights to sum to 1", () => {
        const entity = createEntity("test", "high", {
          success_count: 5,
          failure_count: 5,
          last_applied_at: new Date().toISOString(),
          access_count: 10,
        });

        const config: RerankingConfig = {
          weights: {
            semantic: 10, // Intentionally unnormalized
            recency: 5,
            accessCount: 3,
            successRate: 7,
            priorityBoost: 5,
          },
          minApplicationsForRanking: 3,
        };

        const result = rerankEntitiesWithScores([entity], config);

        // Score should still be in 0-1 range due to normalization
        expect(result[0].score).toBeGreaterThanOrEqual(0);
        expect(result[0].score).toBeLessThanOrEqual(1);
      });

      it("should handle zero weights gracefully", () => {
        const entity = createEntity("test");

        const config: RerankingConfig = {
          weights: {
            semantic: 1,
            recency: 0,
            accessCount: 0,
            successRate: 0,
            priorityBoost: 0,
          },
          minApplicationsForRanking: 3,
        };

        const result = rerankEntitiesWithScores([entity], config);

        // Should only use semantic (normalized to 1.0 weight)
        expect(result[0].score).toBe(result[0].components.semantic);
      });

      it("should handle all zero weights gracefully", () => {
        const entity = createEntity("test");

        const config: RerankingConfig = {
          weights: {
            semantic: 0,
            recency: 0,
            accessCount: 0,
            successRate: 0,
            priorityBoost: 0,
          },
          minApplicationsForRanking: 3,
        };

        const result = rerankEntities([entity], config);

        // With all zero weights, should return original order
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("test");
      });
    });

    describe("weighted formula", () => {
      it("should apply weights correctly", () => {
        const entity = createEntity("test", "high", {
          success_count: 10,
          failure_count: 0,
          last_applied_at: new Date().toISOString(),
          access_count: 100,
        });

        const result = rerankEntitiesWithScores([entity], "balanced");

        // Manual calculation with balanced weights:
        // semantic = 1.0 (first entity)
        // recency ≈ 1.0 (just applied)
        // accessCount ≈ 1.0 (100 accesses, capped)
        // successRate = 1.0 (10/10)
        // priorityBoost = 1.0 (high priority)
        // score = 0.5*1.0 + 0.15*1.0 + 0.1*1.0 + 0.2*1.0 + 0.05*1.0 = 1.0

        expect(result[0].score).toBeCloseTo(1.0, 1);
      });

      it("should correctly combine all five components", () => {
        const now = Date.now();
        const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

        const entity = createEntity("test", "medium", {
          success_count: 5,
          failure_count: 5,
          last_applied_at: oneDayAgo,
          access_count: 10,
        });

        const result = rerankEntitiesWithScores([entity], "balanced");

        // semantic = 1.0
        // recency ≈ 0.5 (1 day ago)
        // accessCount ≈ 0.52 (10 accesses)
        // successRate = 0.5 (5/10)
        // priorityBoost = 0.5 (medium)
        // score = 0.5*1.0 + 0.15*0.5 + 0.1*0.52 + 0.2*0.5 + 0.05*0.5
        //       = 0.5 + 0.075 + 0.052 + 0.1 + 0.025 = 0.752

        expect(result[0].score).toBeCloseTo(0.752, 2);
      });
    });

    describe("preset behaviors", () => {
      it("semantic_heavy preset should prioritize semantic match", () => {
        const entities = [
          // High semantic (first), low others
          createEntity("high-semantic", "low", {
            success_count: 1,
            failure_count: 9,
            access_count: 1,
          }),
          // Low semantic (second), high others
          createEntity("high-others", "high", {
            success_count: 9,
            failure_count: 1,
            last_applied_at: new Date().toISOString(),
            access_count: 100,
          }),
        ];

        const result = rerankEntities(entities, "semantic_heavy");

        // With semantic_heavy (0.7 weight), high-semantic should win
        expect(result[0].id).toBe("high-semantic");
      });

      it("proven_only preset should prioritize success rate", () => {
        const entities = [
          // High semantic (first), low success
          createEntity("high-semantic", "medium", {
            success_count: 1,
            failure_count: 9,
            access_count: 10,
          }),
          // Low semantic (second), high success
          createEntity("high-success", "medium", {
            success_count: 9,
            failure_count: 1,
            access_count: 10,
          }),
        ];

        const result = rerankEntities(entities, "proven_only");

        // With proven_only (0.45 success weight), high-success should win
        expect(result[0].id).toBe("high-success");
      });
    });

    describe("sorting behavior", () => {
      it("should sort by score descending", () => {
        const entities = [
          createEntity("low", "low", {
            success_count: 0,
            failure_count: 10,
            last_applied_at: new Date(
              Date.now() - 30 * 24 * 60 * 60 * 1000,
            ).toISOString(),
            access_count: 1,
          }),
          createEntity("high", "high", {
            success_count: 10,
            failure_count: 0,
            last_applied_at: new Date().toISOString(),
            access_count: 100,
          }),
          createEntity("medium", "medium", {
            success_count: 5,
            failure_count: 5,
            last_applied_at: new Date(
              Date.now() - 7 * 24 * 60 * 60 * 1000,
            ).toISOString(),
            access_count: 10,
          }),
        ];

        const result = rerankEntitiesWithScores(entities);

        expect(result[0].entity.id).toBe("high");
        expect(result[result.length - 1].entity.id).toBe("medium");

        // Scores should be descending
        for (let i = 0; i < result.length - 1; i++) {
          expect(result[i].score).toBeGreaterThanOrEqual(result[i + 1].score);
        }
      });

      it("should maintain stable sort for equal scores", () => {
        const entities = [createEntity("first"), createEntity("second")];

        const result = rerankEntities(entities);

        // With no metadata (all neutral scores), order should be stable
        expect(result[0].id).toBe("first");
        expect(result[1].id).toBe("second");
      });
    });

    describe("edge cases", () => {
      it("should handle entities with partial metadata", () => {
        const entity = createEntity("test", "high", {
          success_count: 5,
          // failure_count missing (defaults to 0)
          // last_applied_at missing
          access_count: 10,
        });

        const result = rerankEntitiesWithScores([entity]);

        expect(result).toHaveLength(1);
        expect(result[0].score).toBeDefined();
        expect(result[0].components.successRate).toBe(1.0); // 5/5
        expect(result[0].components.recency).toBe(0.1); // Never applied
        expect(result[0].components.priorityBoost).toBe(1.0); // High priority
      });

      it("should preserve entity data through re-ranking", () => {
        const entity = createEntity("test", "high", {
          custom_field: "custom_value",
        });
        entity.tags = ["tag1", "tag2"];
        entity.context = "test-context";

        const result = rerankEntities([entity]);

        expect(result[0].id).toBe("test");
        expect(result[0].priority).toBe("high");
        expect(result[0].tags).toEqual(["tag1", "tag2"]);
        expect(result[0].context).toBe("test-context");
        expect(result[0].metadata.custom_field).toBe("custom_value");
      });
    });

    describe("rerankEntitiesWithScores", () => {
      it("should return detailed scoring information", () => {
        const entity = createEntity("test", "high", {
          success_count: 7,
          failure_count: 3,
          last_applied_at: new Date().toISOString(),
          access_count: 50,
        });

        const result = rerankEntitiesWithScores([entity]);

        expect(result[0]).toHaveProperty("entity");
        expect(result[0]).toHaveProperty("score");
        expect(result[0]).toHaveProperty("components");
        expect(result[0].components).toHaveProperty("semantic");
        expect(result[0].components).toHaveProperty("recency");
        expect(result[0].components).toHaveProperty("accessCount");
        expect(result[0].components).toHaveProperty("successRate");
        expect(result[0].components).toHaveProperty("priorityBoost");
      });

      it("should maintain consistency with rerankEntities", () => {
        const entities = [createEntity("first"), createEntity("second")];

        const basic = rerankEntities(entities);
        const detailed = rerankEntitiesWithScores(entities);

        expect(basic.map((e) => e.id)).toEqual(
          detailed.map((s) => s.entity.id),
        );
      });
    });
  });
});
