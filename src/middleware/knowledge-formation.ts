/**
 * Automated Knowledge Formation Middleware
 *
 * After each run, extracts what that run is worth remembering and stores it
 * in graph-memory unless it is already there. Runs asynchronously after the
 * run completes to avoid blocking responses.
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
import {
  searchEntities,
  storeEntity as storeEntityHandler,
  type StoreEntityHandlerInput,
} from "../vendor/svc-rpc/graph-memory/tool-handlers.js";
import { getMemoryAdapter } from "../tools/memory-adapter.js";
import { getConfig } from "../config/index.js";
import { HOST_CONTEXT_TAG } from "../utils/host-context.js";
import { describeAttachedFiles } from "../utils/attached-files.js";

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
const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge extraction specialist. You read one turn of an agent's work or conversation
and record what would be worth knowing later, for this agent or for others who share its memory.

Worth recording:
- Technical knowledge: bug fixes, architectural discoveries, patterns, tradeoffs, edge cases, gotchas.
- Facts shared in conversation that will still matter later: who or what something is, what was
  decided and why, what a participant reported, a date, a preference, a commitment.

Not worth recording: greetings and small talk, routine operations, things true only for this moment,
and the agent's own guesses. What a participant said is recorded as what they said and who said it,
not as a verified fact.

RULES:
1. Each learning must stand on its own. A reader who never saw this conversation should understand
   it, so name the people, things and dates involved.
2. Assign an honest confidence score: how sure you are that this is durable and worth recalling.
3. If nothing was worth recording, return an empty array.

Output JSON only, no markdown. Follow this exact schema: { "learnings": [ { "entity_type":
"learning" | "pattern" | "decision" | "note", "title": "Concise 3-8 word summary naming the subject",
"content": "Detailed explanation with context and specifics (names, dates, file paths, function names)",
"context": "subject area (e.g., graph-memory, middleware, team, product)", "tags": ["tag1", "tag2"],
"priority": "low" | "medium" | "high", "confidence": 0.0-1.0 } ] }

Entity type guidance: - "learning": New knowledge from debugging, discoveries, API behaviors, or
facts learned in conversation - "pattern": Recurring approaches, conventions, anti-patterns -
"decision": Explicit choices with rationale and tradeoffs - "note": General observations, quirks,
workarounds`;

const EXTRACTION_USER_PROMPT = `## Turn Context
Agent Type: {agent_type}
Turn Duration: {duration_ms}ms
Tool Calls Made: {tool_count}

## Said or asked this turn
{conversation_summary}

## How the turn went (last messages)
{final_messages}

---

Extract what is worth remembering from this turn. Be selective - only record knowledge someone
would want to recall later.`;

/** How many search hits the title comparison looks at. */
const TITLE_MATCH_CANDIDATES = 10;

/** Why a learning was judged to be stored already, or how far the check got. */
type DuplicateVerdict =
  | {
      duplicate: true;
      reason: "same-title" | "similar-content";
      matchedId: string;
      similarity?: number;
    }
  | { duplicate: false; check: "scored" | "title-only" };

/**
 * Reduce a title to the form two titles are compared in: lower case, with
 * every run of punctuation or whitespace collapsed to one space.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Decide whether a learning is already in memory.
 *
 * A search hit alone is not evidence of that: search returns whatever shares
 * a keyword with the query. Two things count. An entity with the same title
 * is the same learning. Otherwise memory is asked to score the learning
 * against what it holds, and only a score at or above `threshold` counts.
 *
 * Every failure resolves to "not a duplicate". Storing the same thing twice
 * can be merged later; a learning that is dropped is gone.
 */
async function findDuplicate(
  learning: ExtractedLearning,
  threshold: number,
): Promise<DuplicateVerdict> {
  try {
    const wanted = normalizeTitle(learning.title);
    const found = await searchEntities(getMemoryAdapter(), {
      query: learning.title,
      limit: TITLE_MATCH_CANDIDATES,
    });
    const sameTitle = found.entities.find(
      (entity) => normalizeTitle(entity.title) === wanted,
    );
    if (sameTitle) {
      return { duplicate: true, reason: "same-title", matchedId: sameTitle.id };
    }
  } catch (_error) {
    // The adapter also throws when no workspace is configured, so this
    // covers the fail-fast: nothing is read without a workspace.
  }

  try {
    const scored = await getMemoryAdapter().findSimilarEntities({
      title: learning.title,
      content: learning.content,
    });
    const match = (scored.results ?? []).find(
      (candidate) => candidate.similarity >= threshold,
    );
    if (match) {
      return {
        duplicate: true,
        reason: "similar-content",
        matchedId: match.id,
        similarity: match.similarity,
      };
    }
    return { duplicate: false, check: "scored" };
  } catch (_error) {
    // Memory could not score the learning (an older host, or an outage).
    // The title comparison is then the whole check.
    return { duplicate: false, check: "title-only" };
  }
}

async function storeEntity(
  learning: ExtractedLearning,
): Promise<string | null> {
  try {
    const input: StoreEntityHandlerInput = {
      entity_type: learning.entity_type,
      title: learning.title,
      content: learning.content,
      context: learning.context,
      tags: [...(learning.tags || []), "auto-extracted"],
      priority: learning.priority || "medium",
      status: "active",
      abstraction_level: "raw",
      agent_id: getConfig().runtime.agentId,
      // Auto-formation extras are stored as custom metadata on the entity.
      metadata: {
        formation_method: "automatic",
        extraction_confidence: learning.confidence,
      },
    };

    const result = await storeEntityHandler(getMemoryAdapter(), input);
    return result.id;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(
      { err, errorMessage: err.message },
      "[KnowledgeFormation] Storage error",
    );
    return null;
  }
}

/** Longest slice of one message handed to the extractor. */
const MESSAGE_CHARS = 600;
/** Most messages of each kind handed to the extractor. */
const REQUEST_MESSAGES = 10;
const CLOSING_MESSAGES = 5;

const ROOM_MESSAGE_PATTERN =
  /^\s*<room-message\b([^>]*)>\n[^\n]*\n([\s\S]*?)\n<\/room-message>\s*$/;
const HOST_CONTEXT_PATTERN = new RegExp(
  `\\s*<${HOST_CONTEXT_TAG}\\b[^>]*>[\\s\\S]*?</${HOST_CONTEXT_TAG}>`,
  "g",
);

/** The text of a message, whether its content is a string or content blocks. */
function messageText(msg: BaseMessage): string {
  const content: unknown = msg.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block: unknown) => {
      if (typeof block === "string") {
        return block;
      }
      const text = (block as { type?: string; text?: unknown })?.text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Strip what the host wrapped around a message, keeping what was said.
 *
 * A message from another participant arrives in an envelope whose first line
 * is a fixed trust statement; it becomes `sender (source): text`. Context the
 * host attached (retrieved memory, for one) is removed outright, so entries
 * that are already in memory are not extracted a second time. An attached
 * file is reduced to its name: where it sits on this machine is not a learning.
 */
function plainText(msg: BaseMessage): string {
  const text = describeAttachedFiles(
    messageText(msg).replace(HOST_CONTEXT_PATTERN, ""),
  );
  const room = ROOM_MESSAGE_PATTERN.exec(text);
  if (!room) {
    return text.trim();
  }
  const attrs = room[1] ?? "";
  const from = /\bfrom="([^"]*)"/.exec(attrs)?.[1] ?? "participant";
  const source = /\bsource="([^"]*)"/.exec(attrs)?.[1];
  return `${from}${source ? ` (${source})` : ""}: ${(room[2] ?? "").trim()}`;
}

function clip(text: string): string {
  return text.length > MESSAGE_CHARS
    ? `${text.substring(0, MESSAGE_CHARS)}…`
    : text;
}

/** Where the current run's messages begin in the thread. */
interface RunStart {
  /** Id of the run's first message, when it has one. */
  firstId?: string;
  /** Its position when the run began. */
  index: number;
}

/**
 * Mark where a run begins: at the human messages that arrived with it, which
 * sit at the end of the thread when the run starts.
 */
function markRunStart(messages: BaseMessage[]): RunStart {
  let index = messages.length;
  while (index > 0 && messages[index - 1]?.getType?.() === "human") {
    index--;
  }
  return { firstId: messages[index]?.id, index };
}

/**
 * The messages that belong to the current run. A thread can carry a long
 * history from earlier runs; only this run is new. Without a usable mark the
 * whole thread is returned.
 */
function messagesOfRun(
  messages: BaseMessage[],
  start: RunStart | undefined,
): BaseMessage[] {
  if (!start) {
    return messages;
  }
  const index = start.firstId
    ? messages.findIndex((m) => m.id === start.firstId)
    : start.index;
  if (index < 0 || index >= messages.length) {
    return messages;
  }
  return messages.slice(index);
}

/**
 * Summarize one run for extraction: what was said or asked, which tools ran,
 * and how the run ended.
 */
function summarizeConversation(messages: BaseMessage[]): {
  summary: string;
  finalMessages: string;
  toolCount: number;
} {
  let toolCount = 0;
  const said: string[] = [];
  const toolLines: string[] = [];
  const replies: string[] = [];

  for (const msg of messages) {
    const type = msg.getType?.() ?? "unknown";
    if (type === "human") {
      const text = plainText(msg);
      if (text) {
        said.push(`- ${clip(text)}`);
      }
      continue;
    }
    if (type === "system") {
      continue;
    }
    if (type === "tool") {
      toolCount++;
    }
    if (msg instanceof AIMessage && msg.tool_calls?.length) {
      toolCount += msg.tool_calls.length;
      toolLines.push(
        `Called tools: ${msg.tool_calls.map((tc) => tc.name).join(", ")}`,
      );
    }
    const text = plainText(msg);
    if (text) {
      replies.push(`[${type}]: ${clip(text)}`);
    }
  }

  const summary = [
    ...said.slice(-REQUEST_MESSAGES),
    ...toolLines.slice(0, REQUEST_MESSAGES),
  ].join("\n");
  const finalMessages = replies.slice(-CLOSING_MESSAGES).join("\n\n");

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

  // Function replacers: the inserted text is conversation content, and a
  // string replacement would read `$&` and friends in it as patterns.
  const prompt = EXTRACTION_USER_PROMPT.replace("{agent_type}", () => agentType)
    .replace("{duration_ms}", () => String(duration))
    .replace("{tool_count}", () => String(toolCount))
    .replace("{conversation_summary}", () => summary)
    .replace("{final_messages}", () => finalMessages);

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

  const adapter = getMemoryAdapter();
  const timestamp = new Date().toISOString();
  const outcomeValue = outcome.fulfilled ? "success" : "failure";

  for (const entityId of entityIds) {
    try {
      // Fetch current entity to read its existing outcome counters.
      const node = await adapter.retrieveEntity({ nodeId: entityId });

      if (!node) {
        logger.warn(
          { entityId },
          "[OutcomeTracking] Failed to fetch entity for update",
        );
        continue;
      }

      const metadata =
        (node.properties?.metadata as Record<string, unknown>) || {};

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

      // Write only the changed counter keys; the update merges them
      // into the entity's existing metadata field-by-field, so other
      // fields (title, content, etc.) are preserved.
      await adapter.updateEntity({
        nodeId: entityId,
        properties: {
          metadata: {
            success_count: successCount,
            failure_count: failureCount,
            success_rate: successRate,
            last_applied_at: timestamp,
            application_history: updatedHistory,
          },
        },
        modes: {},
      });

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
      logger.info(
        { agentType, messages: messages.length },
        "[KnowledgeFormation] No learnings extracted",
      );
      return;
    }

    metrics.learningsExtracted += result.learnings.length;

    let accepted = 0;
    for (const learning of result.learnings) {
      const title = learning.title?.trim() ?? "";

      // An empty title or body would make a broken entity.
      if (!title || !learning.content?.trim()) {
        metrics.lowConfidenceSkipped++;
        logger.info(
          { title, reason: "empty" },
          "[KnowledgeFormation] Skipped learning",
        );
        continue;
      }
      if (!(learning.confidence >= config.minConfidence)) {
        metrics.lowConfidenceSkipped++;
        logger.info(
          {
            title,
            reason: "below-confidence",
            confidence: learning.confidence,
            minConfidence: config.minConfidence,
          },
          "[KnowledgeFormation] Skipped learning",
        );
        continue;
      }
      if (accepted >= config.maxLearningsPerTask) {
        metrics.lowConfidenceSkipped++;
        logger.info(
          { title, reason: "over-limit", limit: config.maxLearningsPerTask },
          "[KnowledgeFormation] Skipped learning",
        );
        continue;
      }
      accepted++;

      const verdict = await findDuplicate(
        learning,
        config.deduplicationThreshold,
      );

      if (verdict.duplicate) {
        metrics.duplicatesSkipped++;
        logger.info(
          {
            title,
            reason: verdict.reason,
            matchedId: verdict.matchedId,
            similarity: verdict.similarity,
          },
          "[KnowledgeFormation] Skipped learning",
        );
        continue;
      }

      // Store the learning
      const storedId = await storeEntity(learning);
      if (storedId) {
        metrics.learningsStored++;
        logger.info(
          {
            title,
            entityId: storedId,
            entityType: learning.entity_type,
            confidence: learning.confidence,
            duplicateCheck: verdict.check,
          },
          "[KnowledgeFormation] Stored learning",
        );
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

  // Where each thread's current run began, set in beforeAgent and consumed
  // in afterAgent.
  const runStarts = new Map<string, RunStart>();
  const threadKey = (runtime: any): string =>
    String(runtime?.configurable?.thread_id ?? "");

  return createMiddleware({
    name: "knowledgeFormationMiddleware",

    beforeAgent: async (state: any, runtime: any) => {
      taskStartTime = Date.now();
      runStarts.set(threadKey(runtime), markRunStart(state?.messages ?? []));
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

      const key = threadKey(runConfig);
      const runStart = runStarts.get(key);
      runStarts.delete(key);

      const messages = state.messages;
      if (!messages || messages.length < 3) {
        // Skip trivial conversations
        return;
      }
      const runMessages = messagesOfRun(messages, runStart);

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
          runMessages,
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
                  ? describeAttachedFiles(messageText(firstHumanMsg))
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
