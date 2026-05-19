/**
 * Application Tracking Module
 *
 * Tracks which learnings/patterns are retrieved during task execution
 * to correlate with outcome evaluation.
 */

import { logger } from "./logger.js";

/**
 * Tracked pattern/learning application
 */
export interface TrackedApplication {
  entityId: string;
  retrievedAt: string;
  taskId: string;
}

/**
 * Global tracking map: taskId -> entity IDs
 */
const applicationTracker = new Map<string, Set<string>>();

/**
 * Generate a task ID from config or create a new one
 */
export function getOrCreateTaskId(config?: any): string {
  // Try to extract from LangGraph config (thread_id or run_id)
  if (config?.configurable?.thread_id) {
    return `task_${config.configurable.thread_id}`;
  }
  if (config?.run_id) {
    return `task_${config.run_id}`;
  }

  // Fallback: generate timestamp-based ID
  return `task_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Track that entities were retrieved for a task
 */
export function trackPatternRetrieval(
  entityIds: string[],
  taskId: string,
): void {
  if (!taskId || entityIds.length === 0) {
    return;
  }

  let trackedEntities = applicationTracker.get(taskId);
  if (!trackedEntities) {
    trackedEntities = new Set();
    applicationTracker.set(taskId, trackedEntities);
  }

  entityIds.forEach((id) => trackedEntities!.add(id));

  logger.debug(
    { taskId, entityCount: entityIds.length },
    "[ApplicationTracking] Tracked pattern retrieval",
  );
}

/**
 * Get tracked entity IDs for a task
 */
export function getTrackedEntities(taskId: string): string[] {
  const tracked = applicationTracker.get(taskId);
  return tracked ? Array.from(tracked) : [];
}

/**
 * Clear tracking data for a task (call after outcome evaluation)
 */
export function clearTracking(taskId: string): void {
  applicationTracker.delete(taskId);
}

/**
 * Clear all tracking data (for testing/cleanup)
 */
export function clearAllTracking(): void {
  applicationTracker.clear();
}
