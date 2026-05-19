/**
 * Automated Knowledge Formation Middleware
 *
 * Extracts learnings from completed agent tasks and stores them in graph-memory.
 * Runs asynchronously after task completion to avoid blocking responses.
 */

import { createMiddleware } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  type ExtractionConfig,
  loadExtractionConfig,
  DEFAULT_CONFIG,
  loadOutcomeTrackingConfig,
  type ApplicationEvent,
} from "../config/knowledge-formation-config.js";
import { logger } from "../utils/logger.js";
import { evaluateTaskOutcome, type TaskOutcome } from "./outcome-critic.js";
import {
  getTrackedEntities,
  clearTracking,
  getOrCreateTaskId,
} from "../utils/application-tracking.js";
import { createGraphMemoryClient } from "../clients/graph-memory-client.js";
import { getConfig } from "../config/index.js";

// Types
interface ExtractedLearning {
  entity_type: "learning" | "pattern" | "decision" | "note";
  title: string;
  content: string;
  context?: string;
  tags?: string[];
  priority?: "low" | "medium" | "high";
  confidence: number;
}

interface ExtractionResult {
  learnings: ExtractedLearning[];
}

interface KnowledgeFormationMetrics {
  tasksProcessed: number;
  learningsExtracted: number;
  learningsStored: number;
  duplicatesSkipped: number;
  lowConfidenceSkipped: number;
  errors: number;
}

export interface KnowledgeFormationMiddlewareOptions {
  /** Model to use for extraction (defaults to agent model) */
  model?: BaseChatModel;
  /** Configuration overrides */
  config?: Partial<ExtractionConfig>;
  /** Optional agent type identifier for filtering */
  agentType?: string;
}

// Extraction Prompts
const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge extraction specialist. Analyze the conversation below and extract structured
learnings that would be valuable for future reference.

IMPORTANT RULES: 1. Only extract genuinely useful learnings - not routine operations 2. Focus on:
bug fixes, architectural discoveries, patterns, tradeoffs, edge cases, gotchas 3. Assign honest
confidence scores based on how generalizable/reusable the learning is 4. If nothing valuable was
learned, return an empty array

Output JSON only, no markdown. Follow this exact schema: { "learnings": [ { "entity_type":
"learning" | "pattern" | "decision" | "note", "title": "Concise 3-8 word summary", "content":
"Detailed explanation with context, file paths, function names, and specifics", "context": "system
area (e.g., graph-memory, agent-tools, middleware)", "tags": ["tag1", "tag2"], "priority": "low" |
"medium" | "high", "confidence": 0.0-1.0 } ] }

Entity type guidance: - "learning": New knowledge from debugging, discoveries, API behaviors -
"pattern": Recurring approaches, conventions, anti-patterns - "decision": Explicit choices with
rationale and tradeoffs - "note": General observations, quirks, workarounds`;

const EXTRACTION_USER_PROMPT = `## Task Context
Agent Type: {agent_type}
Task Duration: {duration_ms}ms
Tool Calls Made: {tool_count}

## Conversation Summary
{conversation_summary}

## Final Messages (last 5)
{final_messages}

---

Extract valuable learnings from this task completion. Be selective - only extract genuinely reusable
knowledge.`;

// Graph Memory client with shorter timeout for duplicate checks
const graphMemoryClient = createGraphMemoryClient({ timeout: 10000 });
const duplicateCheckClient = createGraphMemoryClient({ timeout: 5000 });

async function searchForDuplicates(
  content: string,
  threshold: number,
): Promise<{ isDuplicate: boolean; similarId?: string }> {
  try {
    const sanitizedQuery = content.substring(0, 500).replace(/"/g, '\\"');
    const query = `MATCH CONVERSATIONS SEMANTIC "${sanitizedQuery}" THRESHOLD ${threshold} LIMIT 1`;

    const response = (await duplicateCheckClient.query(query)) as {
      success: boolean;
      data?: { nodes?: Array<{ id: string }> };
    };

    if (response.success && response.data?.nodes?.length) {
      return {
        isDuplicate: true,
        similarId: response.data.nodes[0].id,
      };
    }
    return { isDuplicate: false };
  } catch (_error) {
    // On error, assume not duplicate to avoid losing knowledge
    return { isDuplicate: false };
  }
}

async function storeEntity(
  learning: ExtractedLearning,
): Promise<string | null> {
  try {
    const entityData = {
      agent_id: getConfig().runtime.agentId,
      user_input: `[${learning.entity_type}] ${learning.title}`,
      agent_output: learning.content,
      context: learning.context || "general",
      metadata: {
        entity_type: learning.entity_type,
        title: learning.title,
        content: learning.content,
        context: learning.context,
        tags: [...(learning.tags || []), "auto-extracted"],
        priority: learning.priority || "medium",
        status: "active",
        abstraction_level: "raw",
        created_at: new Date().toISOString(),
        formation_method: "automatic",
        extraction_confidence: learning.confidence,
      },
    };

    const response = (await graphMemoryClient.post(
      "/conversations",
      entityData,
    )) as {
      success: boolean;
      data?: { id?: string };
      id?: string;
    };

    if (response.success) {
      return response.data?.id || response.id || null;
    }
    return null;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(
      { err, errorMessage: err.message },
      "[KnowledgeFormation] Storage error",
    );
    return null;
  }
}

/**
 * Summarize conversation for extraction context
 * Uses last N messages and counts tool calls
 */
function summarizeConversation(messages: BaseMessage[]): {
  summary: string;
  finalMessages: string;
  toolCount: number;
} {
  let toolCount = 0;
  const summaryParts: string[] = [];

  // Count tool calls and build summary
  for (const msg of messages) {
    const msgType = msg.getType?.() || "unknown";
    if (msgType === "tool") {
      toolCount++;
    }
    if (msgType === "ai" && msg instanceof AIMessage) {
      if (msg.tool_calls?.length) {
        toolCount += msg.tool_calls.length;
        summaryParts.push(
          `Called tools: ${msg.tool_calls.map((tc) => tc.name).join(", ")}`,
        );
      }
    }
  }

  // Get last 5 messages for detailed context
  const lastMessages = messages.slice(-5);
  const finalMessages = lastMessages
    .map((msg) => {
      const content =
        typeof msg.content === "string"
          ? msg.content.substring(0, 500)
          : JSON.stringify(msg.content).substring(0, 500);
      const type = msg.getType?.() ?? "unknown";
      return `[${type}]: ${content}`;
    })
    .join("\n\n");

  // Build summary from first human message and key interactions
  const firstHuman = messages.find((m) => {
    const type = m.getType?.();
    return type === "human";
  });
  const summary = firstHuman
    ? `Task: ${String(firstHuman.content).substring(0, 300)}\n${summaryParts.slice(0, 10).join("\n")}`
    : summaryParts.slice(0, 10).join("\n");

  return { summary, finalMessages, toolCount };
}

/**
 * Extract learnings using LLM
 */
async function extractLearnings(
  model: BaseChatModel,
  messages: BaseMessage[],
  agentType: string,
  startTime: number,
): Promise<ExtractionResult> {
  const { summary, finalMessages, toolCount } = summarizeConversation(messages);
  const duration = Date.now() - startTime;

  const prompt = EXTRACTION_USER_PROMPT.replace("{agent_type}", agentType)
    .replace("{duration_ms}", String(duration))
    .replace("{tool_count}", String(toolCount))
    .replace("{conversation_summary}", summary)
    .replace("{final_messages}", finalMessages);

  try {
    const response = await model.invoke([
      new SystemMessage(EXTRACTION_SYSTEM_PROMPT),
      new HumanMessage(prompt),
    ]);

    // Extract text content, handling array responses (e.g., reasoning + text blocks)
    let content: string;
    if (typeof response.content === "string") {
      content = response.content;
    } else if (Array.isArray(response.content)) {
      // Extract text from content blocks, skipping reasoning blocks
      content = response.content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("\n");
      if (!content) {
        content = JSON.stringify(response.content);
      }
    } else {
      content = JSON.stringify(response.content);
    }

    // Parse JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as ExtractionResult;
    }
    return { learnings: [] };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(
      { err, errorMessage: err.message, errorName: err.name },
      "[KnowledgeFormation] Extraction error",
    );
    return { learnings: [] };
  }
}

/**
 * Update tracked learnings with task outcome
 */
async function updateAppliedLearningsOutcome(
  entityIds: string[],
  outcome: TaskOutcome,
  taskId: string,
): Promise<void> {
  if (entityIds.length === 0) {
    return;
  }

  // Use client with shorter timeout for outcome tracking
  const outcomeClient = createGraphMemoryClient({ timeout: 5000 });
  const timestamp = new Date().toISOString();
  const outcomeValue = outcome.fulfilled ? "success" : "failure";

  for (const entityId of entityIds) {
    try {
      // Fetch current entity to get existing metadata
      const fetchResponse = (await outcomeClient.get(
        `/graph/nodes/${entityId}`,
      )) as {
        success: boolean;
        data?: { properties?: { metadata?: Record<string, unknown> } };
      };

      if (!fetchResponse.success) {
        logger.warn(
          { entityId },
          "[OutcomeTracking] Failed to fetch entity for update",
        );
        continue;
      }

      const entity = fetchResponse.data;
      const metadata = entity?.properties?.metadata || {};

      // Update counters
      const successCount =
        ((metadata.success_count as number) || 0) + (outcome.fulfilled ? 1 : 0);
      const failureCount =
        ((metadata.failure_count as number) || 0) + (outcome.fulfilled ? 0 : 1);

      // Calculate success rate
      const totalApplications = successCount + failureCount;
      const successRate =
        totalApplications > 0 ? successCount / totalApplications : 0.5;

      // Add to application history (ring buffer)
      const newEvent: ApplicationEvent = {
        task_id: taskId,
        timestamp,
        outcome: outcomeValue,
        confidence: outcome.confidence,
      };

      const history =
        (metadata.application_history as ApplicationEvent[]) || [];
      const updatedHistory = [...history, newEvent].slice(-10); // Keep last 10

      // Prepare update
      const updateData = {
        properties: {
          metadata: {
            ...metadata,
            success_count: successCount,
            failure_count: failureCount,
            success_rate: successRate,
            last_applied_at: timestamp,
            application_history: updatedHistory,
          },
        },
      };

      await outcomeClient.request(
        "PATCH",
        `/graph/nodes/${entityId}`,
        updateData,
      );

      logger.debug(
        { entityId, outcome: outcomeValue, successRate },
        "[OutcomeTracking] Updated learning outcome",
      );
    } catch (error) {
      logger.warn(
        { error, entityId },
        "[OutcomeTracking] Failed to update learning outcome",
      );
    }
  }
}

/**
 * Process and store learnings asynchronously
 */
async function processLearningsAsync(
  model: BaseChatModel,
  messages: BaseMessage[],
  config: ExtractionConfig,
  agentType: string,
  startTime: number,
  metrics: KnowledgeFormationMetrics,
): Promise<void> {
  try {
    metrics.tasksProcessed++;

    // Extract learnings via LLM
    const result = await extractLearnings(
      model,
      messages,
      agentType,
      startTime,
    );

    if (!result.learnings || result.learnings.length === 0) {
      if (config.debugLogging) {
        logger.debug("[KnowledgeFormation] No learnings extracted");
      }
      return;
    }

    metrics.learningsExtracted += result.learnings.length;

    // Filter by confidence and limit count
    const qualifiedLearnings = result.learnings
      .filter((l) => l.confidence >= config.minConfidence)
      .slice(0, config.maxLearningsPerTask);

    metrics.lowConfidenceSkipped +=
      result.learnings.length - qualifiedLearnings.length;

    // Process each learning
    for (const learning of qualifiedLearnings) {
      // Skip learnings with empty title/content to prevent broken entities
      if (!learning.title?.trim() || !learning.content?.trim()) {
        metrics.lowConfidenceSkipped++;
        continue;
      }

      // Check for duplicates
      const { isDuplicate, similarId } = await searchForDuplicates(
        `${learning.title} ${learning.content}`,
        config.deduplicationThreshold,
      );

      if (isDuplicate) {
        metrics.duplicatesSkipped++;
        if (config.debugLogging) {
          logger.debug(
            `[KnowledgeFormation] Duplicate skipped: "${learning.title}" (similar to ${similarId})`,
          );
        }
        continue;
      }

      // Store the learning
      const storedId = await storeEntity(learning);
      if (storedId) {
        metrics.learningsStored++;
        if (config.debugLogging) {
          logger.debug(
            `[KnowledgeFormation] Stored: "${learning.title}" (${storedId})`,
          );
        }
      }
    }
  } catch (error) {
    metrics.errors++;
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(
      { err, errorMessage: err.message },
      "[KnowledgeFormation] Processing error",
    );
  }
}

/**
 * Create Knowledge Formation Middleware
 *
 * Hooks into afterAgent to extract and store learnings asynchronously.
 */
export function createKnowledgeFormationMiddleware(
  options: KnowledgeFormationMiddlewareOptions = {},
) {
  const config: ExtractionConfig = {
    ...DEFAULT_CONFIG,
    ...loadExtractionConfig(),
    ...options.config,
  };

  const agentType = options.agentType || "main";

  // Metrics for logging/monitoring
  const metrics: KnowledgeFormationMetrics = {
    tasksProcessed: 0,
    learningsExtracted: 0,
    learningsStored: 0,
    duplicatesSkipped: 0,
    lowConfidenceSkipped: 0,
    errors: 0,
  };

  // Track task start time
  let taskStartTime = 0;

  return createMiddleware({
    name: "knowledgeFormationMiddleware",

    beforeAgent: async () => {
      taskStartTime = Date.now();
      return; // No state modification
    },

    afterAgent: async (state: any, runConfig: any) => {
      // Check if extraction is enabled
      if (!config.enabled) {
        return;
      }

      // Check if agent type is excluded
      if (config.excludeAgentTypes.includes(agentType)) {
        return;
      }

      const messages = state.messages;
      if (!messages || messages.length < 3) {
        // Skip trivial conversations
        return;
      }

      // Get model from options
      const model = options.model;
      if (!model) {
        logger.warn(
          "[KnowledgeFormation] No model provided, skipping extraction",
        );
        return;
      }

      // Fire-and-forget async processing for learning extraction
      setImmediate(() => {
        processLearningsAsync(
          model,
          messages,
          config,
          agentType,
          taskStartTime,
          metrics,
        ).catch((err) => {
          logger.error({ err }, "[KnowledgeFormation] Async processing failed");
        });
      });

      // Fire-and-forget async outcome tracking
      const outcomeConfig = loadOutcomeTrackingConfig();
      if (outcomeConfig.enabled && outcomeConfig.criticEnabled) {
        const taskId = getOrCreateTaskId(runConfig);
        const trackedEntityIds = getTrackedEntities(taskId);

        if (trackedEntityIds.length > 0) {
          setImmediate(() => {
            void (async () => {
              try {
                // Extract original user request from first human message
                const firstHumanMsg = messages.find(
                  (m: BaseMessage) => m.getType?.() === "human",
                );
                const originalRequest = firstHumanMsg
                  ? typeof firstHumanMsg.content === "string"
                    ? firstHumanMsg.content
                    : JSON.stringify(firstHumanMsg.content)
                  : "Unknown task";

                // Evaluate task outcome
                const outcome = await evaluateTaskOutcome(
                  model,
                  messages,
                  originalRequest,
                );

                // Update tracked learnings with outcome
                await updateAppliedLearningsOutcome(
                  trackedEntityIds,
                  outcome,
                  taskId,
                );

                // Clean up tracking data
                clearTracking(taskId);

                logger.debug(
                  {
                    taskId,
                    outcome: outcome.fulfilled ? "success" : "failure",
                    confidence: outcome.confidence,
                    trackedCount: trackedEntityIds.length,
                  },
                  "[OutcomeTracking] Outcome evaluation complete",
                );
              } catch (err) {
                logger.error(
                  { err, taskId },
                  "[OutcomeTracking] Outcome tracking failed",
                );
              }
            })();
          });
        }
      }

      // Return immediately without modifying state
      return;
    },
  });
}

/**
 * Get current metrics for monitoring
 */
export function getKnowledgeFormationMetrics(): KnowledgeFormationMetrics {
  // Note: In actual implementation, metrics would be module-scoped or passed via closure
  return {
    tasksProcessed: 0,
    learningsExtracted: 0,
    learningsStored: 0,
    duplicatesSkipped: 0,
    lowConfidenceSkipped: 0,
    errors: 0,
  };
}
